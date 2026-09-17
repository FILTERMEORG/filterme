"""FastAPI 서버 진입점 — YouTube 라이브 채팅 수신 → 분석 → 확장으로 broadcast.

전체 흐름
    확장(content.js) --WS accept--> ws()
    ws() 가 videoId 로 Room 을 찾거나 새로 만듦
    Room.run() 이 youtube_stream.stream_chat() 으로 gRPC streamList 연결을 열고
    들어오는 채팅을 버퍼에 쌓았다가(_recv) FLUSH_INTERVAL 마다(_flush)
    analyzer.analyze_batch() 로 일괄 분석 → 같은 Room 을 보는 모든 클라이언트에 전송

핵심 설계: 같은 방송(videoId)을 보는 시청자가 몇 명이든 Room 은 하나,
streamList 연결도 하나, 분석도 채팅당 1번만 한다 (fan-out 은 마지막에 broadcast 로).
그래서 비용/할당량이 "동시 시청자 수"가 아니라 "동시에 필터링 중인 방송 수"에 비례한다.

이 파일이 하지 않는 것: 실제 필터 판정 로직(analyzer.py), YouTube gRPC 통신 세부사항
(youtube_stream.py), REST 로 videoId → liveChatId 조회(youtube.py).
"""
import re
import time
import asyncio
import collections

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from analyzer import analyze_batch
from captions import get_recent_captions
from summarizer import summarize_context
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
SUMMARY_COOLDOWN_SEC = 60  # "최근" 탭 새로고침 쿨다운 — LLM 비용이 드는 쪽만 적용

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
    """방송(videoId) 하나를 대표하는 방. 이 방송을 보는 모든 WebSocket 클라이언트를 묶는다.

    생명주기: 첫 시청자 접속 시 생성 → run() 이 gRPC 스트림을 열고 계속 돎 →
    마지막 시청자가 나가면 30초 유예(새로고침 대비) 후 정리(ws() 의 finally 블록 참고).
    """

    def __init__(self, video_id):
        self.video_id = video_id
        self.clients = set()
        self.task = None
        self._buf = []          # [(author, text)]
        self._lock = asyncio.Lock()
        self._recent = collections.deque(maxlen=60)   # [(author, dup_key)] 최근 도배 판정용

        self._context_texts = collections.deque(maxlen=300)  # 요약용 채팅 텍스트 (모더레이션 _buf와 별개)
        self.last_summary = None       # summarize_context()가 반환한 dict
        self.last_summary_ts = 0.0
        self._summary_lock = asyncio.Lock()  # request_summary 동시 호출 시 LLM 중복 호출 방지 (_lock과는 별개)
        self._mood_counts = {"normal": 0, "profanity": 0, "political": 0, "sexual": 0, "spam": 0}
        self._mood_total = 0

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
            self._context_texts.append(text[:INPUT_MAX])

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
            cats = ("normal", "profanity", "political", "sexual", "spam")
            for (author, text), result in zip(batch, results):
                # 같은 작성자가 이미 보낸 것과 동일한 메시지 → 도배 (한 메시지 안 반복은 analyzer 가 처리)
                key = _dup_key(text)
                if key and any(a == author and k == key for a, k in self._recent):
                    result["spam"] = max(result["spam"], 90)
                    worst = max(result["profanity"], result["political"], result["sexual"], result["spam"])
                    result["normal"] = max(0, 100 - worst)
                if key:
                    self._recent.append((author, key))

                top_cat = max(cats, key=lambda c: result.get(c, 0))
                self._mood_counts[top_cat] += 1
                self._mood_total += 1

                msg = {"type": "analysis", "author": author, "text": text, "result": result}
                for client in list(self.clients):
                    try:
                        await client.send_json(msg)
                    except Exception:
                        pass

            if self._mood_total > 500:
                # 완전 초기화 대신 절반으로 감쇠 — 최근 흐름 위주로 유지하되 그래프가 매번 툭툭 끊겨 보이지 않게
                for c in cats:
                    self._mood_counts[c] //= 2
                # 개별 카운트 합으로 재계산 — mood_total을 별도로 //2 하면 정수 나눗셈 오차가 누적되어
                # 여러 번 감쇠되는 동안 퍼센트 합이 서서히 100%에서 벗어난다.
                self._mood_total = sum(self._mood_counts.values())

            if self._mood_total:
                pct = {c: round(self._mood_counts[c] / self._mood_total * 100) for c in cats}
                mood_msg = {"type": "mood", "percentages": pct}
                for client in list(self.clients):
                    try:
                        await client.send_json(mood_msg)
                    except Exception:
                        pass

    async def request_summary(self, force=False):
        async with self._summary_lock:  # 두 클라이언트가 거의 동시에 새로고침해도 LLM은 한 번만
            now = time.time()
            if not force and self.last_summary is not None and (now - self.last_summary_ts) < SUMMARY_COOLDOWN_SEC:
                await self._broadcast_summary(cached=True)
                return

            captions_text = await get_recent_captions(self.video_id)
            chat_texts = list(self._context_texts)
            result = await summarize_context(captions_text, chat_texts)
            if result is not None:
                self.last_summary = result
                self.last_summary_ts = now
                await self._broadcast_summary(cached=False)
            else:
                # LLM 미연동/실패 시 기존 캐시(없으면 available:false)를 그대로 재전송
                await self._broadcast_summary(cached=True)

    async def _broadcast_summary(self, cached):
        if self.last_summary is None:
            msg = {"type": "summary", "available": False}
        else:
            msg = {
                "type": "summary",
                "available": True,
                "source": self.last_summary["source"],
                "bullets": self.last_summary["bullets"],
                "timeline": self.last_summary["timeline"],
                "cached": cached,
            }
        for client in list(self.clients):
            try:
                await client.send_json(msg)
            except Exception:
                pass


@app.websocket("/ws")
async def ws(sock: WebSocket):
    """확장 하나의 WS 연결. 프로토콜:

    클라이언트 → 서버 (최초 1회, 필수)
        {"videoId": "<11자리 유튜브 videoId>"}
    클라이언트 → 서버 (이후, 선택, 여러 번 가능)
        {"type": "backfill", "texts": ["연결 전부터 화면에 있던 채팅", ...]}
        {"type": "summary_request"}  # "최근" 탭 새로고침 버튼
    서버 → 클라이언트 (실시간 채팅 + backfill 응답 공통)
        {"type": "analysis", "author": str, "text": str,
         "result": {"normal","profanity","political","sexual","spam"}}  # 각 0~100
    서버 → 클라이언트 (신규)
        {"type": "summary", "available": bool, "source"?, "bullets"?, "timeline"?, "cached"?}
        {"type": "mood", "percentages": {...}}  # 쿨다운 없이 flush 주기(1.2초)마다 자동 push
    """
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
    if room.last_summary is None and len(room._context_texts) >= 5:
        asyncio.create_task(room.request_summary())

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
            elif isinstance(data, dict) and data.get("type") == "summary_request":
                await room.request_summary(force=False)
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
