"""라이브 방송 오디오 주기적 캡처. yt-dlp로 오디오 스트림 URL을 얻고,
ffmpeg로 최근 N초만 잘라 WAV bytes로 반환한다. 실패하면 None(호출 쪽이 이번 주기는
건너뛰고 다음 주기에 재시도).

URL 조회(yt-dlp)와 실제 캡처(ffmpeg)를 분리해뒀다 — 오디오 URL은 보통 몇 시간
유효한데, 캡처마다 매번 yt-dlp로 새로 조회하면 호출 빈도가 너무 잦아져서
유튜브 쪽 속도 제한에 걸리기 쉽다. 호출 쪽(main.py)이 URL을 캐싱해두고
실패했을 때만 get_audio_url()을 다시 불러야 한다.
"""
import asyncio

import yt_dlp


# 유튜브가 봇 탐지를 계속 강화하면서 특정 player_client 하나가 막히는 일이 잦다.
# 여러 클라이언트를 순서대로 시도해서 하나라도 되면 쓴다.
_PLAYER_CLIENTS = ["android", "ios", "web", "tv"]


def _get_audio_url(video_id: str) -> str:
    last_error = None
    for client in _PLAYER_CLIENTS:
        opts = {
            "format": "bestaudio/best", "quiet": True, "no_warnings": True,
            "extractor_args": {"youtube": {"player_client": [client]}},
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
            return info["url"]
        except Exception as e:
            last_error = e
    raise last_error


async def get_audio_url(video_id: str) -> str | None:
    """yt-dlp로 오디오 스트림 URL을 새로 조회한다. 호출 쪽이 캐싱해서 재사용해야 한다."""
    try:
        return await asyncio.to_thread(_get_audio_url, video_id)
    except Exception as e:
        print(f"[audio_stream] {video_id} 오디오 URL 조회 실패: {e}")
        return None


async def capture_from_url(url: str, seconds: int) -> bytes | None:
    """이미 얻어둔 오디오 URL로 ffmpeg만 돌린다 — yt-dlp 호출 없음."""
    cmd = ["ffmpeg", "-y", "-i", url, "-t", str(seconds),
           "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        data, _ = await asyncio.wait_for(proc.communicate(), timeout=seconds + 30)
        return data or None
    except Exception as e:
        print(f"[audio_stream] ffmpeg 캡처 실패: {e}")
        return None
