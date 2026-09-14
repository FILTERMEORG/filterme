"""YouTube Data API v3 (REST) 래퍼.

서버(main.py)가 실제로 쓰는 건 `get_live_chat_id()` 하나뿐이다 — videoId 를 받아
`liveStreamingDetails.activeLiveChatId` 를 조회한다 (라이브가 아니면 예외).
실시간 채팅 자체는 이 파일이 아니라 youtube_stream.py(gRPC streamList) 가 받는다.

`poll_chat()` 은 REST `liveChatMessages.list` 폴링 방식 — 초기에 썼다가 채팅이
없어도 계속 요청해 할당량을 금방 소진해서 streamList 로 교체됐다. 지금은 서버가
쓰지 않고, 이 파일을 직접 실행했을 때(`python youtube.py <videoId>`)만 동작하는
CLI 테스트 도구로만 남아 있다.
"""
import os
import sys
import time

from dotenv import load_dotenv
from googleapiclient.discovery import build

from analyzer import analyze

load_dotenv()
yt = None


def get_youtube_client():
    global yt
    if yt is None:
        api_key = os.getenv("YOUTUBE_API_KEY")
        if not api_key:
            raise RuntimeError("YOUTUBE_API_KEY가 설정되지 않았습니다.")
        yt = build("youtube", "v3", developerKey=api_key)
    return yt


def get_live_chat_id(video_id):
    r = get_youtube_client().videos().list(
        part="liveStreamingDetails", id=video_id
    ).execute()
    items = r.get("items", [])
    if not items:
        raise RuntimeError("영상 없음")
    chat_id = items[0].get("liveStreamingDetails", {}).get("activeLiveChatId")
    if not chat_id:
        raise RuntimeError("진행 중인 라이브가 아님")
    return chat_id


# ⚠️ 레거시: 서버는 이제 이 함수를 쓰지 않는다 (youtube_stream.stream_chat 로 대체됨).
# CLI 로 이 파일을 직접 실행할 때(아래 __main__)만 쓰인다.
def poll_chat(video_id):
    chat_id = get_live_chat_id(video_id)
    page_token = None
    while True:
        r = get_youtube_client().liveChatMessages().list(
            liveChatId=chat_id,
            part="snippet,authorDetails",
            pageToken=page_token,
        ).execute()
        for item in r.get("items", []):
            author = item["authorDetails"]["displayName"]
            text = item["snippet"].get("displayMessage", "")
            yield author, text
        page_token = r.get("nextPageToken")
        time.sleep(r.get("pollingIntervalMillis", 5000) / 1000)


if __name__ == "__main__":
    for author, text in poll_chat(sys.argv[1]):
        print(f"{author}: {text} -> {analyze(text)}")