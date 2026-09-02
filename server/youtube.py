import os
import sys
import time

from dotenv import load_dotenv
from googleapiclient.discovery import build

from analyzer import analyze

load_dotenv()
yt = build("youtube", "v3", developerKey=os.getenv("YOUTUBE_API_KEY"))


def get_live_chat_id(video_id):
    r = yt.videos().list(part="liveStreamingDetails", id=video_id).execute()
    items = r.get("items", [])
    if not items:
        raise RuntimeError("영상 없음")
    chat_id = items[0].get("liveStreamingDetails", {}).get("activeLiveChatId")
    if not chat_id:
        raise RuntimeError("진행 중인 라이브가 아님")
    return chat_id


def poll_chat(video_id):
    chat_id = get_live_chat_id(video_id)
    page_token = None
    while True:
        r = yt.liveChatMessages().list(
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