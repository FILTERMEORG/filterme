"""요약 생성 — LLM 제공자는 아직 미정, provider를 환경변수로 분리.

방송요약은 "압축 롤링 요약" 방식이다: 이전 요약 + 새로 들어온 STT 텍스트를 합쳐서
매번 새 요약을 만들고, 원본 텍스트는 버린다. 그래서 메모리에 계속 쌓이는 게 없다.
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

_SUMMARY_SCHEMA_NOTE = (
    "다음 JSON 형식으로만 응답하세요. 다른 텍스트나 코드블록 없이 JSON 객체 하나만 출력합니다:\n"
    '{{"topic": "지금 하고 있는 이야기를 한 문장으로", '
    '"bullets": ["핵심 내용 1", "핵심 내용 2", "핵심 내용 3"]}}\n'
    f"bullets는 가장 핵심적인 내용만 최대 {_MAX_BULLETS}개까지만 담아주세요."
)

SUMMARY_PROMPT_FIRST = (
    "다음은 라이브 방송에서 스트리머가 실제로 말한 내용을 받아적은 음성 전사입니다. "
    "지금까지 어떤 이야기가 있었는지 정리해주세요. " + _SUMMARY_SCHEMA_NOTE +
    "\n\n전사:\n{content}"
)
SUMMARY_PROMPT_UPDATE = (
    "다음은 라이브 방송 요약을 갱신하는 작업입니다. 이전 요약과 그 이후 새로 들어온 "
    "음성 전사를 참고해서, 최신 상황을 반영한 새 요약을 만들어주세요. "
    "이미 지난 화제는 굳이 유지하지 말고, 지금 방송에서 진행 중인 내용 위주로 "
    "정리해주세요. " + _SUMMARY_SCHEMA_NOTE +
    "\n\n이전 요약:\n주제: {prev_topic}\n{prev_bullets}"
    "\n\n새로 들어온 전사:\n{content}"
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
            return data
    except Exception:
        pass
    return None


async def summarize_recent(previous: dict | None, new_text: str) -> dict | None:
    """방송 STT 텍스트로 "지금 무슨 이야기 중" 요약을 만들거나 갱신한다.
    previous: 이전 summarize_recent() 결과({"topic","bullets"}) 또는 첫 요약이면 None.
    반환: {"topic": str, "bullets": [...]} 또는 내용/LLM이 부족하면 None."""
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
