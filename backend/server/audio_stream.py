"""라이브 방송 오디오 주기적 캡처. yt-dlp로 오디오 스트림 URL을 얻고,
ffmpeg로 최근 N초만 잘라 WAV bytes로 반환한다. 실패하면 None(호출 쪽이 이번 주기는
건너뛰고 다음 주기에 재시도).
"""
import asyncio

import yt_dlp


def _get_audio_url(video_id: str) -> str:
    opts = {"format": "bestaudio/best", "quiet": True, "no_warnings": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    return info["url"]


async def capture_audio_chunk(video_id: str, seconds: int) -> bytes | None:
    try:
        url = await asyncio.to_thread(_get_audio_url, video_id)
    except Exception as e:
        print(f"[audio_stream] {video_id} 오디오 URL 조회 실패: {e}")
        return None

    cmd = ["ffmpeg", "-y", "-i", url, "-t", str(seconds),
           "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        data, _ = await asyncio.wait_for(proc.communicate(), timeout=seconds + 30)
        return data or None
    except Exception as e:
        print(f"[audio_stream] {video_id} ffmpeg 캡처 실패: {e}")
        return None
