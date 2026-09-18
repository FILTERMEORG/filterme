"""요약 생성 — LLM 제공자는 아직 미정, provider를 환경변수로 분리.
반환 형식이 타임라인(시간별 로그)까지 포함하도록 확장됨 (v2).
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
_MAX_TIMELINE = 6

_SCHEMA_NOTE = (
    "다음 JSON 형식으로만 응답하세요. 다른 텍스트나 코드블록 없이 JSON 객체 하나만 출력합니다:\n"
    '{{"bullets": ["요약 문장 1", "요약 문장 2"], '
    '"timeline": [{{"time": "HH:MM", "text": "그 시점에 있었던 일"}}, ...]}}\n'
    f"bullets는 가장 핵심적인 내용만 최대 {_MAX_BULLETS}개까지, "
    f"timeline은 최근 순으로 최대 {_MAX_TIMELINE}개까지만 담아주세요. "
    "방송이 길어져도 이 개수를 넘기지 마세요."
)

CAPTION_PROMPT = (
    "다음은 라이브 방송에서 스트리머가 실제로 말한 내용의 자막입니다. "
    "방금 들어온 시청자에게 지금까지 어떤 내용이었는지 정리해주세요. " + _SCHEMA_NOTE +
    "\n\n자막:\n{content}"
)
CHAT_PROMPT = (
    "다음은 라이브 방송 채팅 로그입니다. 스트리머의 발언을 직접 본 게 아니라 "
    "시청자들의 채팅 반응만 보고 추정하는 상황이니, bullets와 timeline의 text 모두 "
    "'~인 것 같아요' 같은 추정 어투로 작성해주세요. " + _SCHEMA_NOTE +
    "\n\n채팅:\n{content}"
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
        "generationConfig": {"responseMimeType": "application/json"},  # JSON 모드 — _parse_llm_json 성공률↑
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


def _parse_llm_json(raw: str) -> dict | None:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else cleaned
    try:
        data = json.loads(cleaned)
        if isinstance(data.get("bullets"), list) and isinstance(data.get("timeline"), list):
            # 프롬프트로 개수를 요청해도 LLM이 안 지킬 수 있어 서버에서 한 번 더 강제로 자른다
            # (방송이 길어질수록 요약이 계속 늘어나 가독성이 떨어지는 것을 방지).
            data["bullets"] = data["bullets"][:_MAX_BULLETS]
            data["timeline"] = data["timeline"][:_MAX_TIMELINE]
            return data
    except Exception:
        pass
    return None


async def summarize_context(captions_text: str | None, chat_texts: list[str]) -> dict | None:
    """반환: {"source": "captions"|"chat", "bullets": [...], "timeline": [{"time","text"}, ...]}
    또는 내용/LLM이 부족하면 None."""
    if captions_text and captions_text.strip():
        raw = await _call_llm(CAPTION_PROMPT.format(content=captions_text[-4000:]))
        parsed = _parse_llm_json(raw) if raw else None
        if parsed:
            return {"source": "captions", **parsed}

    if chat_texts:
        joined = "\n".join(chat_texts[-120:])
        raw = await _call_llm(CHAT_PROMPT.format(content=joined))
        parsed = _parse_llm_json(raw) if raw else None
        if parsed:
            return {"source": "chat", **parsed}

    return None
