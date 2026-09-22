"""오디오 → 텍스트 변환 — faster-whisper(오픈소스, 로컬 추론)로 처리.
외부 API 호출이 없어 요청 한도가 없다. 대신 이 서버의 CPU/메모리를 쓴다.
"""
import io
import os

import asyncio

from faster_whisper import WhisperModel

_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "small")  # tiny/base/small/medium/large-v3
_model = None


def _get_model():
    global _model
    if _model is None:
        _model = WhisperModel(_MODEL_SIZE, device="cpu", compute_type="int8")
    return _model


def _transcribe(wav_bytes: bytes) -> str | None:
    model = _get_model()
    segments, _info = model.transcribe(io.BytesIO(wav_bytes), language="ko")
    text = " ".join(seg.text.strip() for seg in segments if seg.text.strip())
    return text or None


async def transcribe_audio(wav_bytes: bytes) -> str | None:
    return await asyncio.to_thread(_transcribe, wav_bytes)
