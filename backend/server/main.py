import re
import asyncio
import collections

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from analyzer import analyze_batch
from youtube import get_live_chat_id
from youtube_stream import stream_chat

app = FastAPI()

# --- 악용 안전망 ---
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
MAX_ROOMS = 100
MAX_TOTAL_CLIENTS = 500
BACKFILL_MAX = 50
INPUT_MAX = 200

FLUSH_INTERVAL = 1.2   # 초. 이 주기로 모아서 배치 분석
BUF_CAP = 500          # 버퍼 상한 (분석이 느릴 때 무한 증가 방지)

rooms = {}


def _total_clients():
    return sum(len(r.clients) for r in rooms.values())


def _dup_key(t):
    """동일 메시지 판단용 정규화 (도배 감지). 공백 제거 + 소문자."""
    return re.sub(r"\s+", "", (t or "").lower())


@app.get("/health")
def health():
    return {"status": "ok"}


class Room:
    def __init__(self, video_id):
        self.video_id = video_id
        self.clients = set()
        self.task = None
        self._buf = []          # [(author, text)]
        self._lock = asyncio.Lock()
        self._recent = collections.deque(maxlen=60)   # [(author, dup_key)] 최근 도배 판정용

    async def run(self):
        try:
            chat_id = await asyncio.to_thread(get_live_chat_id, self.video_id)
        except Exception as e:
            # 라이브가 아니거나 조회 실패 → 스트림은 못 열지만 클라이언트는 유지
            # (backfill·키워드 필터는 계속 동작). 방은 마지막 클라 나갈 때 정리됨.
            print(f"[room {self.video_id}] chat_id 실패(스트림 없음): {e}")
            return

        recv = asyncio.create_task(self._recv(chat_id))
        flush = asyncio.create_task(self._flush_loop())
        try:
            await asyncio.gather(recv, flush)
        finally:
            recv.cancel()
            flush.cancel()

    async def _recv(self, chat_id):
        async for author, text in stream_chat(chat_id):
            if not text:
                continue
            self._buf.append((author, text[:INPUT_MAX]))
            if len(self._buf) > BUF_CAP:
                self._buf = self._buf[-BUF_CAP:]

    async def _flush_loop(self):
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            await self._flush()

    async def _flush(self):
        async with self._lock:
            if not self._buf:
                return
            batch = self._buf
            self._buf = []
            if not self.clients:
                return
            texts = [t for _, t in batch]
            results = await analyze_batch(texts)
            for (author, text), result in zip(batch, results):
                # 같은 작성자가 이미 보낸 것과 동일한 메시지 → 도배 (한 메시지 안 반복은 analyzer 가 처리)
                key = _dup_key(text)
                if key and any(a == author and k == key for a, k in self._recent):
                    result["spam"] = max(result["spam"], 90)
                    worst = max(result["profanity"], result["political"], result["sexual"], result["spam"])
                    result["normal"] = max(0, 100 - worst)
                if key:
                    self._recent.append((author, key))

                msg = {"type": "analysis", "author": author, "text": text, "result": result}
                for client in list(self.clients):
                    try:
                        await client.send_json(msg)
                    except Exception:
                        pass


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    try:
        req = await sock.receive_json()
    except Exception:
        await sock.close(code=1003)
        return

    video_id = (req or {}).get("videoId", "")
    if not isinstance(video_id, str) or not VIDEO_ID_RE.match(video_id):
        await sock.close(code=1008)
        return
    if _total_clients() >= MAX_TOTAL_CLIENTS:
        await sock.close(code=1013)
        return

    room = rooms.get(video_id)
    if room is None:
        if len(rooms) >= MAX_ROOMS:
            await sock.close(code=1013)
            return
        room = Room(video_id)
        rooms[video_id] = room
        room.task = asyncio.create_task(room.run())
    room.clients.add(sock)

    try:
        while True:
            data = await sock.receive_json()
            if isinstance(data, dict) and data.get("type") == "backfill":
                texts = [str(t)[:INPUT_MAX] for t in (data.get("texts") or [])][:BACKFILL_MAX]
                if not texts:
                    continue
                results = await analyze_batch(texts)
                for text, result in zip(texts, results):
                    await sock.send_json({
                        "type": "analysis",
                        "author": "",
                        "text": text,
                        "result": result,
                    })
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        room.clients.discard(sock)
        if not room.clients:
            await asyncio.sleep(30)
            if not room.clients:
                if room.task:
                    room.task.cancel()
                rooms.pop(video_id, None)
