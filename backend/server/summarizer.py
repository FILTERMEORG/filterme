"""요약 생성 — LLM 제공자는 아직 미정, provider를 환경변수로 분리.

방송요약은 "압축 롤링 요약" 방식이다: 이전 요약 + 새로 들어온 채팅 텍스트를 합쳐서
매번 새 요약을 만들고, 원본 텍스트는 버린다. 그래서 메모리에 계속 쌓이는 게 없다.
입력은 채팅뿐이지만, 프롬프트가 "AI가 방송을 직접 보고 정리한 것"처럼 자신 있게
서술하도록 강제한다(채팅에서 봤다는 티를 내지 않음).
"""
import json
import os

import httpx
from dotenv import load_dotenv

load_dotenv()  # analyzer.py와 동일한 관례

LLM_PROVIDER = os.getenv("FM_LLM_PROVIDER", "")   # "anthropic" | "openai" | "google" | ""
LLM_API_KEY = os.getenv("FM_LLM_API_KEY", "")
LLM_MODEL = os.getenv("FM_LLM_MODEL", "")

_MAX_BULLETS = 3
_MAX_HOT_TOPICS = 5

_SUMMARY_SCHEMA_NOTE = (
    "다음 JSON 형식으로만 응답하세요. 다른 텍스트나 코드블록 없이 JSON 객체 하나만 출력합니다:\n"
    '{{"topic": "지금 하고 있는 이야기를 한 문장으로", '
    '"bullets": ["핵심 내용 1", "핵심 내용 2", "핵심 내용 3"], '
    '"hot_topics": [{{"topic": "주제 이름", "count": 정수}}, ...]}}\n'
    f"bullets는 가장 핵심적인 내용만 최대 {_MAX_BULLETS}개까지만 담아주세요. "
    "hot_topics는 표현이 달라도 같은 걸 묻거나 말하는 채팅은 하나의 주제로 묶어서 "
    "(예: '신캐 언제 나와요?', '출시일 언제?', '신캐 날짜 공개됨?' → '신캐 출시일' 하나로), "
    "지금 채팅에서 가장 많이 언급되는 주제를 언급 빈도가 높은 순으로 최대 "
    f"{_MAX_HOT_TOPICS}개까지, count(그 주제에 해당하는 채팅이 대략 몇 개인지)와 함께 담아주세요."
)

_NO_SOURCE_RULE = (
    "당신은 이 라이브 방송을 직접 보고 있는 것처럼 방송 내용을 정리합니다. "
    "입력이 채팅 로그든, 자막이든, 음성 전사든 그 출처를 절대 언급하지 마세요 "
    "('채팅에서', '채팅 반응을 보면', '시청자들이', '자막에 따르면' 같은 표현 금지). "
    "실제로 방송에서 있었던 일을 직접 본 것처럼 확신 있게 서술해주세요."
)

SUMMARY_PROMPT_FIRST = (
    _NO_SOURCE_RULE + " 다음 내용을 참고해서 지금까지 방송에서 어떤 이야기가 있었는지 "
    "정리해주세요. " + _SUMMARY_SCHEMA_NOTE +
    "\n\n내용:\n{content}"
)
SUMMARY_PROMPT_UPDATE = (
    _NO_SOURCE_RULE + " 다음은 방송 요약을 갱신하는 작업입니다. 이전 요약과 그 이후 "
    "새로 들어온 내용을 참고해서, 최신 상황을 반영한 새 요약을 만들어주세요. "
    "이미 지난 화제는 굳이 유지하지 말고, 지금 방송에서 진행 중인 내용 위주로 "
    "정리해주세요. " + _SUMMARY_SCHEMA_NOTE +
    "\n\n이전 요약:\n주제: {prev_topic}\n{prev_bullets}"
    "\n\n새로 들어온 내용:\n{content}"
)


async def _call_llm(prompt: str) -> str | None:
    if not LLM_PROVIDER or not LLM_API_KEY:
        return None
    if LLM_PROVIDER == "anthropic":
        # TODO: anthropic SDK messages.create 호출, model은 FM_LLM_MODEL 환경변수로 분리
        pass
    elif LLM_PROVIDER == "openai":
        # TODO: openai SDK chat.completions 호출
        pass
    elif LLM_PROVIDER == "google":
        return await _call_gemini(prompt)
    return None


async def _call_gemini(prompt: str) -> str | None:
    if not LLM_MODEL:
        print("[summarizer] FM_LLM_MODEL이 설정되지 않았습니다.")
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{LLM_MODEL}:generateContent?key={LLM_API_KEY}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json"},  # JSON 모드 — _parse_summary_json 성공률↑
    }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(url, json=payload)
        if r.status_code != 200:
            print(f"[summarizer] gemini {r.status_code}: {r.text[:300]}")
            return None
        data = r.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print(f"[summarizer] gemini 호출 오류: {e}")
        return None


def _parse_summary_json(raw: str) -> dict | None:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else cleaned
    try:
        data = json.loads(cleaned)
        if isinstance(data.get("topic"), str) and isinstance(data.get("bullets"), list):
            # 프롬프트로 개수를 요청해도 LLM이 안 지킬 수 있어 서버에서 한 번 더 강제로 자른다.
            data["bullets"] = data["bullets"][:_MAX_BULLETS]
            hot_topics = data.get("hot_topics")
            data["hot_topics"] = hot_topics[:_MAX_HOT_TOPICS] if isinstance(hot_topics, list) else []
            return data
    except Exception:
        pass
    return None


async def summarize_recent(previous: dict | None, new_text: str) -> dict | None:
    """채팅 텍스트로 "지금 무슨 이야기 중" 방송요약과 핫토픽을 한 번의 LLM 호출로
    같이 만들거나 갱신한다.
    previous: 이전 summarize_recent() 결과({"topic","bullets"}) 또는 첫 요약이면 None.
    반환: {"topic": str, "bullets": [...], "hot_topics": [{"topic","count"}, ...]}
    또는 내용/LLM이 부족하면 None."""
    if not new_text or not new_text.strip():
        return None

    if previous is None:
        prompt = SUMMARY_PROMPT_FIRST.format(content=new_text[-4000:])
    else:
        prev_bullets = "\n".join(f"- {b}" for b in previous.get("bullets", []))
        prompt = SUMMARY_PROMPT_UPDATE.format(
            prev_topic=previous.get("topic", ""),
            prev_bullets=prev_bullets,
            content=new_text[-4000:],
        )

    raw = await _call_llm(prompt)
    return _parse_summary_json(raw) if raw else None
