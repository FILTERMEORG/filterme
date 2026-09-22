"""유튜브 라이브 자동 자막(자동 생성 캡션) 조회.

공식 YouTube Data API가 아니라 yt-dlp가 쓰는 비공식 자막 매니페스트를 그대로 이용한다.
이 매니페스트는 항상 최근 30초 안팎의 슬라이딩 윈도우만 보여주므로, 과거 구간은
다루지 않고 실시간으로 주기적 폴링만 한다. videoId만 있으면 되고 API 키가 필요 없다.
"""
import re
import asyncio

import httpx
import yt_dlp

_LANG_PRIORITY = ("ko", "en")
_SQ_RE = re.compile(r"/sq/(\d+)/")
# 유튜브 봇 탐지 우회 — audio_stream.py와 동일한 이유로 여러 클라이언트를 순서대로 시도.
_PLAYER_CLIENTS = ["android", "ios", "web", "tv"]


def _extract_caption_track(video_id: str):
    """(lang, manifest_url) 또는 자동 자막이 아예 없으면 None."""
    last_error = None
    for client in _PLAYER_CLIENTS:
        opts = {
            "quiet": True, "no_warnings": True,
            "extractor_args": {"youtube": {"player_client": [client]}},
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
            tracks = info.get("automatic_captions") or {}
            for lang in _LANG_PRIORITY:
                if tracks.get(lang):
                    return lang, tracks[lang][0]["url"]
            return None  # 조회는 됐는데 이 방송에 자동 자막이 없음
        except Exception as e:
            last_error = e
    print(f"[live_captions] {video_id} 자막 확인 실패(모든 클라이언트): {last_error}")
    return None


async def get_caption_track(video_id: str):
    return await asyncio.to_thread(_extract_caption_track, video_id)


_TAG_RE = re.compile(r"<[^>]+>")


def _parse_vtt(raw: str) -> list[str]:
    lines = []
    for block in raw.split("\n\n"):
        for line in block.splitlines():
            if not line or "-->" in line or line.startswith(("WEBVTT", "X-TIMESTAMP-MAP", "Kind:")):
                continue
            text = _TAG_RE.sub("", line).strip()
            if text:
                lines.append(text)
    # 자동 자막은 같은 줄을 단어 단위로 점진적으로 다시 그려서 보여준다 —
    # 앞 줄이 다음 줄의 접두어(또는 그 반대)면 짧은 쪽을 버리고 최종본만 남긴다.
    dedup = []
    for line in lines:
        if dedup and line.startswith(dedup[-1]):
            dedup[-1] = line
        elif dedup and dedup[-1].startswith(line):
            continue
        else:
            dedup.append(line)
    return dedup


async def poll_new_captions(manifest_url: str, last_sq: int):
    """매니페스트를 한 번 조회해 last_sq 이후의 새 세그먼트만 텍스트로 반환한다.
    반환: (새 텍스트 또는 None, 갱신된 last_sq)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(manifest_url)
        if r.status_code != 200:
            return None, last_sq

        seg_urls = []
        for line in r.text.splitlines():
            if line.startswith("https"):
                m = _SQ_RE.search(line)
                if m and int(m.group(1)) > last_sq:
                    seg_urls.append((int(m.group(1)), line))
        if not seg_urls:
            return None, last_sq
        seg_urls.sort()

        new_texts = []
        async with httpx.AsyncClient(timeout=10) as client:
            for _, url in seg_urls:
                try:
                    seg = await client.get(url, follow_redirects=True)
                    if seg.status_code == 200:
                        new_texts.extend(_parse_vtt(seg.text))
                except Exception:
                    pass
        return ("\n".join(new_texts) if new_texts else None), seg_urls[-1][0]
    except Exception as e:
        print(f"[live_captions] 폴링 실패: {e}")
        return None, last_sq
