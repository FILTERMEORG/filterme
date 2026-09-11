"""채팅 분석기.

- 성적/욕설: OpenAI Moderation API(무료) + 키워드
- 정치: 키워드 (Moderation 에 카테고리 없음)
- 도배: 정규식
Moderation 실패/429 시 키워드만으로 폴백 (과금·다운 없음).
"""
import re
import os
import asyncio

import httpx
from dotenv import load_dotenv

load_dotenv()

REPEAT = re.compile(r"(.)\1{3,}")
URL = re.compile(r"https?://|www\.")
_WORD_RE = re.compile(r"[a-z0-9*@#]+")

_OPENAI_KEY = os.getenv("OPENAI_API_KEY")
_MOD_URL = "https://api.openai.com/v1/moderations"
_MOD_MODEL = "omni-moderation-latest"
_BATCH = 30          # moderation input 배열 크기
_INPUT_MAX = 200     # 채팅 1건 최대 길이

print(f"[analyzer] Moderation API {'사용' if _OPENAI_KEY else '키 없음 → 키워드 전용'}")

# --- 영어 욕설 (노골적인 것만; damn/piss/ass/hell 처럼 약하거나 오탐 큰 건 제외) ---
BADWORDS_EN = {
    "fuck", "fucking", "fuckin", "fucker", "fucked", "motherfucker", "motherfucking",
    "fuk", "fck", "fuckyou", "stfu", "wtf", "gtfo",
    "shit", "shitty", "bullshit", "shithead",
    "bitch", "bitches", "asshole", "assholes", "dumbass", "jackass",
    "cunt", "dick", "dickhead", "cock", "pussy", "bastard",
    "slut", "whore", "nigger", "nigga", "niggas", "faggot", "fag", "retard", "retarded",
}
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "@": "a", "$": "s"})
_EN_SUBSTR = ("fuckyou", "fuck", "fck", "phuck", "shit", "bitch", "biatch", "asshole", "motherfuck")


def _kw_en(m: str) -> bool:
    low = m.lower()
    if set(_WORD_RE.findall(low)) & BADWORDS_EN:
        return True
    de = low.translate(_LEET).replace("*", "").replace(" ", "")
    return any(w in de for w in _EN_SUBSTR)


# --- 한국어 사전 ---
BADWORDS = [
    "시발", "씨발", "ㅅㅂ", "ㅆㅂ", "시1발", "씨1발", "ㅄ", "ㅂㅅ", "병신", "븅신",
    "존나", "ㅈㄴ", "좆", "좃", "개새끼", "새끼", "ㅅㄲ", "니애미", "느금마", "엄마없",
    "지랄", "ㅈㄹ", "닥쳐", "ㄷㅊ", "꺼져", "ㄲㅈ", "등신", "머저리", "쓰레기같", "개같",
    "미친놈", "미친년", "죽어라", "뒤져", "엿먹",
]
POLITICAL_KW = [
    "대통령", "국회", "여당", "야당", "민주당", "국민의힘", "국힘", "조국", "조국당",
    "이재명", "윤석열", "석열", "한동훈", "오세훈", "용혜인", "정청래", "김어준", "유시민",
    "선거", "대선", "총선", "탄핵", "지지율", "여론조사", "여조", "정권", "좌파", "우파",
    "빨갱이", "친문", "친명", "文", "종북", "대깨",
]
SEXUAL_KW = [
    "섹스", "sex", "야동", "19금", "자위", "꼴리", "꼴린", "발기", "몸매", "가슴골",
    "젖", "보지", "자지", "떡치", "야짤", "노출", "관계하", "하고싶", "밤새", "같이자",
    "핥", "빨아", "애무",
]


def _kw(t, words):
    return any(w in t for w in words)


def _norm(t):
    return t.lower().replace(" ", "")


def _spam(m):
    if REPEAT.search(m):
        return 90
    if len(m) >= 5 and len(set(m.replace(" ", ""))) <= 2:
        return 88
    if URL.search(m):
        return 70
    return 0


def _mod_score(md, cat):
    """Moderation 카테고리 점수 0~100. flagged 불린이면 최소 80으로 끌어올림
    (raw 점수가 가벼운 욕설엔 0.4~0.5 로 낮게 나옴)."""
    raw = (md.get("category_scores") or {}).get(cat) or 0
    flagged = (md.get("categories") or {}).get(cat, False)
    s = int(round(raw * 100))
    return max(80, s) if flagged else s


async def moderate(texts):
    """OpenAI Moderation. list[dict] 반환, 실패 시 None (→ 키워드 폴백)."""
    if not _OPENAI_KEY or not texts:
        return None
    payload = {"model": _MOD_MODEL, "input": texts}
    headers = {"Authorization": f"Bearer {_OPENAI_KEY}"}
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.post(_MOD_URL, json=payload, headers=headers)
            if r.status_code == 200:
                return r.json().get("results")
            if r.status_code == 429:
                if attempt == 0:
                    await asyncio.sleep(1.5)
                    continue
                print("[analyzer] moderation 429 → 키워드 폴백")
                return None
            print(f"[analyzer] moderation {r.status_code}: {r.text[:200]}")
            return None
        except Exception as e:
            print(f"[analyzer] moderation 오류: {e}")
            if attempt == 0:
                await asyncio.sleep(1)
                continue
            return None
    return None


def _combine(message: str, md) -> dict:
    """키워드 + (있으면) Moderation 결과 md 를 합쳐 5개 항목 점수."""
    m = (message or "").strip()
    n = _norm(m)

    prof_kw = 90 if (_kw(n, BADWORDS) or _kw_en(m)) else 0
    pol_kw = 85 if _kw(m, POLITICAL_KW) else 0
    sex_kw = 85 if _kw(n, SEXUAL_KW) else 0

    prof_mod = sex_mod = 0
    if md:
        prof_mod = max(_mod_score(md, "harassment"), _mod_score(md, "hate"))
        sex_mod = _mod_score(md, "sexual")
        if (md.get("categories") or {}).get("sexual/minors"):
            sex_mod = 100

    profanity = max(prof_kw, prof_mod)
    sexual = max(sex_kw, sex_mod)
    political = pol_kw  # Moderation 에 정치 카테고리 없음
    spam = _spam(m)

    # 보정: 욕설 강하면 sexual 오탐 억제 (성적 신호가 약할 때만)
    if profanity >= 55 and sex_kw == 0 and sex_mod < 55:
        sexual = min(sexual, 15)
    # 보정: 스팸이면 나머지 낮춤
    if spam >= 80:
        profanity = min(profanity, 30)
        sexual = min(sexual, 15)
        political = min(political, 15)

    normal = max(0, 100 - max(profanity, political, sexual, spam))
    return {
        "normal": normal,
        "profanity": profanity,
        "political": political,
        "sexual": sexual,
        "spam": spam,
    }


async def analyze_batch(texts):
    """채팅 여러 건을 Moderation 배치 + 키워드로 분석. 입력 순서대로 dict 리스트 반환."""
    texts = [(t or "")[:_INPUT_MAX] for t in texts]
    out = []
    for i in range(0, len(texts), _BATCH):
        chunk = texts[i:i + _BATCH]
        mod = await moderate(chunk)
        for j, t in enumerate(chunk):
            out.append(_combine(t, mod[j] if mod else None))
    return out


def analyze(message: str) -> dict:
    """키워드 전용 (youtube.py CLI · 폴백용). AI 판정은 analyze_batch 를 쓴다."""
    return _combine(message, None)
