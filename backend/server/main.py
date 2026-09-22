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
from audio_stream import capture_audio_chunk
from captions import transcribe_audio
from summarizer import summarize_recent
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
STT_CHUNK_SEC = 60          # 한 번에 캡처하는 오디오 길이(초)
STT_CHUNKS_PER_SUMMARY = 3  # 이 개수(약 3분)만큼 모이면 요약을 갱신

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

        self._context_texts = collections.deque(maxlen=300)  # 채팅 모더레이션용 (요약과는 별개, 핫토픽에서 재사용 예정)

        self._recent_stt = []          # 아직 요약에 반영 안 된 STT 조각들 (최대 STT_CHUNKS_PER_SUMMARY개)
        self._current_summary = None   # summarize_recent()가 반환한 {"topic","bullets"} — 압축 롤링 요약
        self._summary_updated_at = 0.0

        self._mood_counts = {"normal": 0, "profanity": 0, "political": 0, "sexual": 0, "spam": 0}
        self._mood_total = 0

    async def run(self):
        # STT 캡처(_stt_loop)는 유튜브 채팅 API(get_live_chat_id)와 완전히 독립적이라
        # 채팅 조회 성공 여부와 무관하게 항상 시작한다.
        stt = asyncio.create_task(self._stt_loop())
        try:
            chat_id = await asyncio.to_thread(get_live_chat_id, self.video_id)
        except Exception as e:
            # 라이브가 아니거나 조회 실패 → 채팅 스트림은 못 열지만 클라이언트는 유지
            # (backfill·키워드 필터·방송요약은 계속 동작). 방은 마지막 클라 나갈 때 정리됨.
            print(f"[room {self.video_id}] chat_id 실패(스트림 없음): {e}")
            try:
                await stt
            finally:
                stt.cancel()
            return

        recv = asyncio.create_task(self._recv(chat_id))
        flush = asyncio.create_task(self._flush_loop())
        try:
            await asyncio.gather(recv, flush, stt)
        finally:
            recv.cancel()
            flush.cancel()
            stt.cancel()

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

    async def _stt_loop(self):
        """방송 오디오를 STT_CHUNK_SEC(60초)씩 캡처해 전사한다. STT_CHUNKS_PER_SUMMARY개
        (약 3분)가 모이면 이전 요약과 합쳐 새 압축 요약을 만들고 원본 텍스트는 버린다 —
        그래서 _recent_stt/_current_summary 둘 다 계속 작게 유지된다."""
        while True:
            audio = await capture_audio_chunk(self.video_id, STT_CHUNK_SEC)
            if not audio:
                await asyncio.sleep(5)
                continue
            text = await transcribe_audio(audio)
            if not text:
                continue
            self._recent_stt.append(text)

            if len(self._recent_stt) >= STT_CHUNKS_PER_SUMMARY:
                joined = "\n".join(self._recent_stt)
                self._recent_stt = []
                summary = await summarize_recent(self._current_summary, joined)
                if summary is not None:
                    self._current_summary = summary
                    self._summary_updated_at = time.time()
                    await self._broadcast_summary()

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

    def _snapshot_message(self):
        if self._current_summary is None:
            return {"type": "summary", "available": False}
        return {
            "type": "summary",
            "available": True,
            "topic": self._current_summary["topic"],
            "bullets": self._current_summary["bullets"],
        }

    async def _broadcast_summary(self):
        msg = self._snapshot_message()
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
    서버 → 클라이언트 (실시간 채팅 + backfill 응답 공통)
        {"type": "analysis", "author": str, "text": str,
         "result": {"normal","profanity","political","sexual","spam"}}  # 각 0~100
    서버 → 클라이언트 (신규)
        {"type": "summary", "available": bool, "topic"?: str, "bullets"?: [str, ...]}
        # 접속 시 즉시 1회 전송되고, 이후 STT_CHUNKS_PER_SUMMARY개(약 3분)가 모일 때마다
        # 서버가 알아서 다시 push한다 — 클라이언트가 새로고침을 요청하는 프로토콜은 없다.
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
    try:
        await sock.send_json(room._snapshot_message())
    except Exception:
        pass

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
