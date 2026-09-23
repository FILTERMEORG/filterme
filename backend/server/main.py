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
CHAT_SUMMARY_INTERVAL_SEC = 180  # 방송요약+핫토픽 분석을 이 주기(3분)마다 확인
MIN_CHAT_FOR_ANALYSIS = 5   # 첫 분석 시도 최소 채팅 수 + 재확인 시 "새로 쌓인 채팅" 최소 개수로도 재사용
KICKOFF_RETRY_SEC = 20      # 첫 분석 재료가 아직 부족하면 이 간격으로 재시도(성공하면 루프 종료)
STATS_BROADCAST_SEC = 7      # 채팅 분위기/언어 비율 push 주기 — 집계는 채팅마다 하되 화면 갱신만 이만큼 뜸하게

rooms = {}


def _total_clients():
    return sum(len(r.clients) for r in rooms.values())


def _dup_key(t):
    """동일 메시지 판단용 정규화 (도배 감지). 공백 제거 + 소문자."""
    return re.sub(r"\s+", "", (t or "").lower())


_HANGUL_RE = re.compile(r"[가-힣ᄀ-ᇿ㄰-㆏]")
_KANA_RE = re.compile(r"[぀-ゟ゠-ヿ]")
_CJK_RE = re.compile(r"[一-鿿]")
_LATIN_RE = re.compile(r"[A-Za-z]")


def _detect_lang(t):
    """유니코드 문자 범위만으로 대략적인 언어를 추정한다 (LLM 호출 없음, 비용 없음).
    가나(히라가나/가타카나)가 있으면 한자가 섞여 있어도 일본어로 본다 —
    한자만으로는 중국어/일본어를 구분할 수 없어서 가나 유무를 우선 신호로 쓴다."""
    if not t:
        return "other"
    if _KANA_RE.search(t):
        return "ja"
    counts = {
        "ko": len(_HANGUL_RE.findall(t)),
        "zh": len(_CJK_RE.findall(t)),
        "en": len(_LATIN_RE.findall(t)),
    }
    best = max(counts, key=counts.get)
    return best if counts[best] > 0 else "other"


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

        self._context_texts = collections.deque(maxlen=300)  # 채팅 모더레이션용 + 방송요약/핫토픽 공용 재료
        self._context_total_seen = 0     # 누적 수신 채팅 수(절대 안 줄어듦) — "그 사이 새로 늘었는지" 판단용
        self._last_analyzed_seen = 0     # 마지막으로 분석이 실제 성공했을 때의 _context_total_seen 값

        self._current_summary = None   # summarize_recent()가 반환한 {"topic","bullets"} — 압축 롤링 요약
        self._summary_updated_at = 0.0
        self._summary_lock = asyncio.Lock()  # 접속-즉시 트리거와 주기 갱신이 동시에 겹치지 않게
        self._analyzed_once = False   # 첫 분석이 한 번이라도 성공했는지 — 한 번 True면 영구 True
        self._analyzing = False       # 지금 이 순간 LLM 호출이 진행 중인지(프론트 "분석 중" 표시용)

        self._hot_topics = None  # summarize_recent()가 같은 호출에서 같이 반환한 [{"topic","count"}, ...] — 최신 결과만 유지

        self._mood_counts = {"normal": 0, "profanity": 0, "political": 0, "sexual": 0, "spam": 0}
        self._mood_total = 0
        self._lang_counts = {"ko": 0, "ja": 0, "zh": 0, "en": 0, "other": 0}
        self._lang_total = 0

    async def run(self):
        # 방송요약/채팅분위기/핫토픽 전부 채팅(gRPC streamList)에서 나오는 재료라,
        # 채팅 조회 자체가 실패하면 이 방은 할 수 있는 게 없다(backfill·키워드 필터만 남음).
        try:
            chat_id = await asyncio.to_thread(get_live_chat_id, self.video_id)
        except Exception as e:
            print(f"[room {self.video_id}] chat_id 실패(스트림 없음): {e}")
            return

        recv = asyncio.create_task(self._recv(chat_id))
        flush = asyncio.create_task(self._flush_loop())
        stats = asyncio.create_task(self._stats_loop())
        analyze = asyncio.create_task(self._analyze_loop())
        kickoff = asyncio.create_task(self._kickoff_analysis_loop())
        try:
            await asyncio.gather(recv, flush, stats, analyze, kickoff)
        finally:
            recv.cancel()
            flush.cancel()
            stats.cancel()
            analyze.cancel()
            kickoff.cancel()

    async def _recv(self, chat_id):
        async for author, text in stream_chat(chat_id):
            if not text:
                continue
            trimmed = text[:INPUT_MAX]
            self._buf.append((author, trimmed))
            if len(self._buf) > BUF_CAP:
                self._buf = self._buf[-BUF_CAP:]

            self._context_texts.append(trimmed)
            self._context_total_seen += 1

    async def _flush_loop(self):
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            await self._flush()

    async def _analyze_loop(self):
        """CHAT_SUMMARY_INTERVAL_SEC(3분)마다 확인하되, 마지막 분석 이후 새 채팅이
        MIN_CHAT_FOR_ANALYSIS(5)개 이상 쌓였을 때만 다시 분석한다 — 3분 됐다고 무조건
        LLM을 부르면 조용한 방송에서 낭비라서, "새로 쌓인 양"을 조건으로 건다. 채팅이
        많은 방송은 사실상 매 3분 갱신되고, 조용한 방송은 몇 주기를 건너뛰다가 쌓이면
        그때 갱신된다. 방송요약과 핫토픽을 한 번의 LLM 호출로 같이 받아온다(summarize_recent
        가 둘 다 반환)."""
        while True:
            await asyncio.sleep(CHAT_SUMMARY_INTERVAL_SEC)
            new_since = self._context_total_seen - self._last_analyzed_seen
            if new_since < MIN_CHAT_FOR_ANALYSIS:
                continue
            await self._update_analysis("\n".join(self._context_texts))

    async def _kickoff_analysis_loop(self):
        """3분 주기(_analyze_loop)를 기다리지 않고 첫 분석(방송요약+핫토픽)을 최대한
        빨리 보여주기 위한 보조 루프. 채팅이 MIN_CHAT_FOR_ANALYSIS개 모일 때까지
        KICKOFF_RETRY_SEC(20초) 간격으로 계속 재시도하다가, 한 번 성공하면 스스로
        끝난다 — 그 뒤로는 _analyze_loop이 이어받음. _context_texts가 시간 만료 없는
        개수 기반(maxlen=300) 버퍼라 계속 재시도해도 "느린 채팅이 영원히 굶는" 문제가
        없다."""
        while self._current_summary is None:
            if len(self._context_texts) >= MIN_CHAT_FOR_ANALYSIS:
                await self._update_analysis("\n".join(self._context_texts))
            if self._current_summary is None:
                await asyncio.sleep(KICKOFF_RETRY_SEC)
        await self._update_analysis("\n".join(self._context_texts))

    def _hot_topics_message(self):
        if self._analyzed_once:
            return {"type": "hot_topics", "available": True, "topics": self._hot_topics or []}
        phase = "analyzing" if self._analyzing else "insufficient"
        return {"type": "hot_topics", "available": False, "phase": phase}

    async def _broadcast_hot_topics(self):
        msg = self._hot_topics_message()
        for client in list(self.clients):
            try:
                await client.send_json(msg)
            except Exception as e:
                print(f"[room {self.video_id}] hot_topics 전송 실패: {e!r}")

    async def _update_analysis(self, new_text):
        async with self._summary_lock:
            self._analyzing = True
            if not self._analyzed_once:
                # 첫 분석 전(아직 available:false)일 때만 "분석 중" 표시가 의미 있음 —
                # 이미 결과가 있으면 재분석 중에도 기존 결과를 그대로 보여주는 게 맞아서
                # 이 broadcast는 실질적으로 무시된다(_snapshot_message가 _analyzed_once
                # 우선으로 판단하므로).
                await self._broadcast_summary()
                await self._broadcast_hot_topics()
            try:
                result = await summarize_recent(self._current_summary, new_text)
            finally:
                self._analyzing = False
            if result is not None:
                self._current_summary = {"topic": result["topic"], "bullets": result["bullets"]}
                self._hot_topics = result.get("hot_topics", [])
                self._analyzed_once = True
                self._summary_updated_at = time.time()
                self._last_analyzed_seen = self._context_total_seen
            await self._broadcast_summary()
            await self._broadcast_hot_topics()

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

                lang = _detect_lang(text)
                self._lang_counts[lang] += 1
                self._lang_total += 1

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

            if self._lang_total > 500:
                for lang in self._lang_counts:
                    self._lang_counts[lang] //= 2
                self._lang_total = sum(self._lang_counts.values())

            # mood/language 자체는 broadcast 안 함 — _stats_loop이 몇 초에 한 번 묶어서 보낸다
            # (집계는 채팅마다 하되 화면 갱신은 뜸하게, 1.2초마다 다시 그릴 필요는 없음).

    async def _stats_loop(self):
        while True:
            await asyncio.sleep(STATS_BROADCAST_SEC)
            await self._broadcast_stats()

    def _stats_message(self):
        if not self._mood_total and not self._lang_total:
            return None
        cats = ("normal", "profanity", "political", "sexual", "spam")
        langs = ("ko", "ja", "zh", "en", "other")
        msg = {"type": "mood"}
        if self._mood_total:
            msg["percentages"] = {c: round(self._mood_counts[c] / self._mood_total * 100) for c in cats}
        if self._lang_total:
            msg["languages"] = {l: round(self._lang_counts[l] / self._lang_total * 100) for l in langs}
        return msg

    async def _broadcast_stats(self):
        msg = self._stats_message()
        if msg is None:
            return
        for client in list(self.clients):
            try:
                await client.send_json(msg)
            except Exception as e:
                print(f"[room {self.video_id}] stats 전송 실패: {e!r}")

    def _snapshot_message(self):
        if self._analyzed_once:
            return {
                "type": "summary",
                "available": True,
                "topic": self._current_summary["topic"],
                "bullets": self._current_summary["bullets"],
            }
        phase = "analyzing" if self._analyzing else "insufficient"
        return {"type": "summary", "available": False, "phase": phase}

    async def _broadcast_summary(self):
        msg = self._snapshot_message()
        for client in list(self.clients):
            try:
                await client.send_json(msg)
            except Exception as e:
                print(f"[room {self.video_id}] summary 전송 실패: {e!r}")


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
        {"type": "summary", "available": bool, "phase"?: "insufficient"|"analyzing", "topic"?: str, "bullets"?: [str, ...]}
        {"type": "hot_topics", "available": bool, "phase"?: "insufficient"|"analyzing", "topics"?: [{"topic": str, "count": int}, ...]}
        # 방송요약과 핫토픽은 한 번의 분석에서 같이 나온다. 첫 분석 전(available:false)엔
        # phase로 "채팅 부족(insufficient)"과 "LLM 호출 중(analyzing)"을 구분해서 보내고,
        # 한 번이라도 분석에 성공하면 그 뒤로는 영구히 available:true + 최신 결과만 보낸다
        # (그 뒤로 phase는 안 보냄 — 재분석 중에도 기존 결과를 그대로 보여주면 되니까).
        # 채팅이 MIN_CHAT_FOR_ANALYSIS개 모이면 접속 직후 첫 분석이 빠르게 뜨고, 이후
        # CHAT_SUMMARY_INTERVAL_SEC(3분)마다 그 사이 새 채팅이 MIN_CHAT_FOR_ANALYSIS개
        # 이상 쌓였으면 서버가 알아서 다시 push한다 — 클라이언트가 새로고침을 요청하는
        # 프로토콜은 없다.
        {"type": "mood", "percentages"?: {...}, "languages"?: {...}}
        # 집계는 채팅마다 하지만 push는 STATS_BROADCAST_SEC(약 7초)마다 한 번, 접속 시 1회 추가 전송
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
        stats_msg = room._stats_message()
        if stats_msg is not None:
            await sock.send_json(stats_msg)
        await sock.send_json(room._hot_topics_message())
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
    except WebSocketDisconnect:
        pass  # 정상 종료(새로고침/탭 닫기 등) — 로그 안 남김
    except Exception as e:
        # 정상 종료가 아닌 다른 예외 — 조용히 삼키면 진짜 버그가 "connection closed"로만
        # 보여서 디버그가 안 되므로 반드시 찍는다.
        print(f"[ws {video_id}] 예상치 못한 예외로 연결 종료: {e!r}")
    finally:
        room.clients.discard(sock)
        if not room.clients:
            await asyncio.sleep(30)
            if not room.clients:
                if room.task:
                    room.task.cancel()
                rooms.pop(video_id, None)
