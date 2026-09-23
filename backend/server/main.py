"""FastAPI 서버 진입점 — 확장이 DOM에서 관찰한 YouTube 라이브 채팅을 받아 분석 → broadcast.

전체 흐름
    확장(content.js) --WS accept--> ws()
    ws() 가 videoId 로 Room 을 찾거나 새로 만듦
    확장이 DOM(MutationObserver)으로 관찰한 채팅을 {"type":"chat", ...} 로 계속 올려주면
    Room._ingest_live_chat() 이 중복 제거 후 버퍼에 쌓았다가(_recv 자리를 대신함)
    FLUSH_INTERVAL 마다(_flush) analyzer.analyze_batch() 로 일괄 분석
    → 같은 Room 을 보는 모든 클라이언트에 전송

핵심 설계: 같은 방송(videoId)을 보는 시청자가 몇 명이든 Room 은 하나,
분석도 채팅당 1번만 한다 (fan-out 은 마지막에 broadcast 로). 여러 시청자가 같은 채팅을
각자 DOM에서 중복으로 올려도 Room이 (작성자, 텍스트) 기준으로 걸러낸다.
YouTube API(REST/gRPC)를 전혀 쓰지 않아서 쿼터 개념 자체가 없다.

이 파일이 하지 않는 것: 실제 필터 판정 로직(analyzer.py).
"""
import re
import time
import asyncio
import collections

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from analyzer import analyze_batch
from summarizer import summarize_recent

app = FastAPI()

# --- 악용 안전망 ---
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
MAX_ROOMS = 100
MAX_TOTAL_CLIENTS = 500
BACKFILL_MAX = 50
INPUT_MAX = 200

FLUSH_INTERVAL = 1.2   # 초. 이 주기로 모아서 배치 분석
BUF_CAP = 500          # 버퍼 상한 (분석이 느릴 때 무한 증가 방지)
LIVE_DEDUP_CAP = 2000  # 여러 시청자가 같은 채팅을 중복으로 올리는 걸 걸러내는 캐시 상한
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

    생명주기: 첫 시청자 접속 시 생성 → run() 이 백그라운드 루프들을 돌림 →
    마지막 시청자가 나가면 30초 유예(새로고침 대비) 후 정리(ws() 의 finally 블록 참고).
    """

    def __init__(self, video_id):
        self.video_id = video_id
        self.clients = set()
        self.task = None
        self._buf = []          # [(author, text)]
        self._lock = asyncio.Lock()
        self._recent = collections.deque(maxlen=60)   # [(author, dup_key)] 최근 도배 판정용

        self._seen_live_keys = set()   # (author, dup_key) 중복 제거용 — 여러 시청자가 같은 채팅을 올려도 1번만 처리
        self._seen_live_order = collections.deque()  # 위 set에서 오래된 것부터 빼기 위한 순서 기록 — maxlen을 안 쓰는 이유는
        # deque 자체 maxlen으로 자동 제거하면 밀려난 키가 set에는 안 지워져서 set만 무한정 커지기 때문(아래에서 둘을 같이 관리)

        self._context_texts = collections.deque(maxlen=300)  # 채팅 모더레이션용 + 방송요약/핫토픽 공용 재료
        self._context_total_seen = 0     # 누적 수신 채팅 수(절대 안 줄어듦) — "그 사이 새로 늘었는지" 판단용
        self._last_analyzed_seen = 0     # 마지막으로 분석이 실제 성공했을 때의 _context_total_seen 값

        self._current_summary = None   # summarize_recent()가 반환한 {"topic","bullets"} — 압축 롤링 요약
        self._summary_updated_at = 0.0
        self._summary_lock = asyncio.Lock()  # 접속-즉시 트리거와 주기 갱신이 동시에 겹치지 않게
        self._analyzed_once = False   # 첫 분석이 한 번이라도 성공했는지 — 한 번 True면 영구 True
        self._analyzing = False       # 지금 이 순간 LLM 호출이 진행 중인지(프론트 "분석 중" 표시용)
        self._enough_chat_event = asyncio.Event()  # _context_texts가 첫 분석 문턱을 넘는 순간 kickoff 루프를 즉시 깨움

        self._hot_topics = None  # summarize_recent()가 같은 호출에서 같이 반환한 [{"topic","count"}, ...] — 최신 결과만 유지

        self._mood_counts = {"normal": 0, "profanity": 0, "political": 0, "sexual": 0, "spam": 0}
        self._mood_total = 0
        self._lang_counts = {"ko": 0, "ja": 0, "zh": 0, "en": 0, "other": 0}
        self._lang_total = 0

    async def run(self):
        flush = asyncio.create_task(self._flush_loop())
        stats = asyncio.create_task(self._stats_loop())
        analyze = asyncio.create_task(self._analyze_loop())
        kickoff = asyncio.create_task(self._kickoff_analysis_loop())
        try:
            await asyncio.gather(flush, stats, analyze, kickoff)
        finally:
            flush.cancel()
            stats.cancel()
            analyze.cancel()
            kickoff.cancel()

    def _ingest_context(self, text):
        """방송요약/핫토픽 공용 재료 버퍼에 채팅 하나를 넣는다. 실시간 수신(_ingest_live_chat)과
        backfill(ws()) 양쪽에서 같이 쓴다."""
        self._context_texts.append(text)
        self._context_total_seen += 1
        if not self._analyzed_once and len(self._context_texts) >= MIN_CHAT_FOR_ANALYSIS:
            # 첫 분석 문턱을 막 넘긴 순간 — _kickoff_analysis_loop이 20초 기다리지 않고
            # 바로 깨어나게 함. 문턱 넘기 전까지 여러 번 호출돼도 Event.set()은 멱등이라 안전.
            self._enough_chat_event.set()

    def _ingest_live_chat(self, author, text):
        """확장이 DOM에서 관찰해 WS로 올려준 실시간 채팅 하나를 받는다(과거 _recv 자리).
        같은 방송을 보는 시청자 여러 명이 각자 DOM에서 같은 채팅을 관찰해서 중복으로
        올릴 수 있으므로, (작성자, 정규화 텍스트) 기준으로 이미 처리한 건 무시한다."""
        if not text:
            return
        trimmed = text[:INPUT_MAX]
        key = (author, _dup_key(trimmed))
        if key in self._seen_live_keys:
            return
        self._seen_live_keys.add(key)
        self._seen_live_order.append(key)
        if len(self._seen_live_order) > LIVE_DEDUP_CAP:
            old = self._seen_live_order.popleft()
            self._seen_live_keys.discard(old)

        self._buf.append((author, trimmed))
        if len(self._buf) > BUF_CAP:
            self._buf = self._buf[-BUF_CAP:]

        self._ingest_context(trimmed)

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
        빨리 보여주기 위한 보조 루프. 채팅이 MIN_CHAT_FOR_ANALYSIS개 모이는 순간
        (_ingest_context가 _enough_chat_event를 set) 즉시 깨어나서 시도하고, 혹시
        이벤트를 놓쳐도 KICKOFF_RETRY_SEC(20초)마다 안전하게 한 번씩 재확인한다.
        한 번 성공하면 스스로 끝나고 그 뒤로는 _analyze_loop이 이어받음. _context_texts
        가 시간 만료 없는 개수 기반(maxlen=300) 버퍼라 계속 재시도해도 "느린 채팅이
        영원히 굶는" 문제가 없다."""
        while self._current_summary is None:
            if len(self._context_texts) >= MIN_CHAT_FOR_ANALYSIS:
                await self._update_analysis("\n".join(self._context_texts))
                if self._current_summary is not None:
                    break
            self._enough_chat_event.clear()
            try:
                await asyncio.wait_for(self._enough_chat_event.wait(), timeout=KICKOFF_RETRY_SEC)
            except asyncio.TimeoutError:
                pass

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
        # 접속 시 1회, 그 전부터 화면에 있던 채팅 캐치업용
        {"type": "chat", "author": str, "text": str}
        # 확장이 DOM(MutationObserver)에서 새 채팅을 감지할 때마다 계속 보냄 — 서버가
        # YouTube API 없이 채팅을 받는 유일한 경로. 여러 시청자가 같은 채팅을 각자
        # 보내도 서버가 (작성자, 텍스트) 기준으로 중복 제거한다.
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
                if not room._analyzed_once:
                    # 첫 분석 전에만 재료로 씀 — 접속 전부터 화면에 있던 채팅까지 반영해서
                    # 실시간 채팅이 쌓이길 기다리지 않고 더 빨리 첫 분석을 띄울 수 있다.
                    # 이미 한 번 분석했으면 여러 명이 잇달아 접속할 때마다 겹치는 DOM
                    # 스냅샷이 계속 섞여 들어가는 걸 막기 위해 더 이상 안 넣는다.
                    for text in texts:
                        room._ingest_context(text)
                results = await analyze_batch(texts)
                for text, result in zip(texts, results):
                    await sock.send_json({
                        "type": "analysis",
                        "author": "",
                        "text": text,
                        "result": result,
                    })
            elif isinstance(data, dict) and data.get("type") == "chat":
                text = str(data.get("text") or "")[:INPUT_MAX]
                author = str(data.get("author") or "")
                if text:
                    # _flush_loop이 이미 FLUSH_INTERVAL마다 self._buf를 비우고 분석+broadcast
                    # 하므로, 여기선 버퍼에 넣기만 하면 됨(과거 _recv가 하던 일과 동일).
                    room._ingest_live_chat(author, text)
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
