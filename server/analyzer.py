import re

PROFANITY = [
    "시발", "씨발", "ㅅㅂ", "병신", "ㅄ", "존나", "새끼", "지랄", "닥쳐", "꺼져",
    "개소리", "개새끼", "좆", "좃", "씹", "닥치", "미친놈", "미친년", "등신", "빡대가리",
]

POLITICAL = [
    "대통령", "대선", "국회", "여당", "야당", "좌파", "우파", "보수", "진보",
    "민주당", "국민의힘", "국힘", "조국당", "진보당", "선거", "탄핵", "정권", "정치",
    "이재명", "윤석열", "석열", "김어준", "유시민", "조국", "한동훈", "오세훈",
    "정청래", "지지율", "여론조사", "여조", "검찰", "친문", "친명",
]

SEXUAL = [
    "섹스", "야동", "19금", "가슴", "몸매", "야한", "꼴린", "노출", "변태",
    "빨통", "젖", "보지", "자지", "꼴리", "떡치", "야짤",
]

URL = re.compile(r"https?://|www\.")
REPEAT = re.compile(r"(.)\1{3,}")

def _has(text, words):
    return any(w in text for w in words)

def analyze(message: str) -> dict:
    m = message or ""
    profanity = 80 if _has(m, PROFANITY) else 0
    political = 80 if _has(m, POLITICAL) else 0
    sexual = 80 if _has(m, SEXUAL) else 0
    spam = 80 if REPEAT.search(m) or URL.search(m) else 0
    normal = 0 if (profanity or political or sexual or spam) else 90
    return{
         "normal": normal,
        "profanity": profanity,
        "political": political,
        "sexual": sexual,
        "spam": spam,
    }