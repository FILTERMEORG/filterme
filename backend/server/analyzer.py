"""채팅 분석기. AI(임베딩+회귀) + 사전 하이브리드."""
import re
import pathlib
import pickle

REPEAT = re.compile(r"(.)\1{3,}")
URL = re.compile(r"https?://|www\.")
_WORD_RE = re.compile(r"[a-z0-9*@#]+")

# 영어 욕설 (노골적인 것만; damn/piss/ass/hell 처럼 약하거나 오탐 큰 건 제외)
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

_MODEL_DIR = pathlib.Path(__file__).parent / "model"
_st = None
_clf = {}
try:
    from sentence_transformers import SentenceTransformer
    _st = SentenceTransformer("jhgan/ko-sroberta-multitask")
    for c in ["profanity", "sexual", "political"]:
        with open(_MODEL_DIR / f"{c}.pkl", "rb") as f:
            _clf[c] = pickle.load(f)
    print("[analyzer] AI 모델 로드 완료")
except Exception as e:
    print(f"[analyzer] 모델 없음, 사전만 사용: {e}")

# --- 사전 ---
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
    t = t.lower().replace(" ", "")
    return t

def _spam(m):
    if REPEAT.search(m):
        return 90
    if len(m) >= 5 and len(set(m.replace(" ", ""))) <= 2:
        return 88
    if URL.search(m):
        return 70
    return 0


def analyze(message: str) -> dict:
    m = (message or "").strip()
    n = _norm(m)

    # AI 점수
    if _clf and _st:
        v = _st.encode([m], normalize_embeddings=True)
        ai = {c: int(round(_clf[c].predict_proba(v)[0][1] * 100)) for c in _clf}
    else:
        ai = {"profanity": 0, "sexual": 0, "political": 0}

    # 사전 점수
    prof_kw = 90 if (_kw(n, BADWORDS) or _kw_en(m)) else 0
    pol_kw = 85 if _kw(m, POLITICAL_KW) else 0
    sex_kw = 85 if _kw(n, SEXUAL_KW) else 0

    profanity = max(ai["profanity"], prof_kw)
    political = max(ai["political"], pol_kw)
    sexual = max(ai["sexual"], sex_kw)

    # 보정: 욕설 강하면 sexual 오탐 억제 (사전에 성적 단어 없을 때만)
    if profanity >= 55 and sex_kw == 0:
        sexual = min(sexual, 15)
    # 보정: 스팸이면 나머지 낮춤
    spam = _spam(m)
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

