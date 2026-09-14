"""YouTube 라이브 채팅 실시간 수신 (gRPC streamList).

`liveChatMessages.list`(REST, 폴링) 대신 `streamList`(gRPC, server-streaming)를 쓴다.
폴링은 채팅이 없어도 주기적으로 요청해 할당량을 소모하지만, streamList는 연결 하나를
계속 열어두고 YouTube 가 새 채팅이 생길 때만 push 한다 — 할당량·지연 모두 유리하다.

`stream_list_pb2*.py` 는 `stream_list.proto` 를 `grpc_tools.protoc` 로 컴파일한
자동생성 코드이므로 직접 수정하지 않는다 (스키마 바꾸려면 .proto 고치고 재컴파일).

이 파일이 유일하게 하는 일: videoId 로 얻은 liveChatId 로 스트림을 열고
(작성자, 텍스트) 튜플을 계속 yield 하는 것. 방(Room) 관리·분석은 main.py 담당,
liveChatId 조회는 youtube.py 담당.
"""
import os
import sys

import grpc
import grpc.aio
from dotenv import load_dotenv

import stream_list_pb2
import stream_list_pb2_grpc

load_dotenv()
API_KEY = os.getenv("YOUTUBE_API_KEY")
HOST = "youtube.googleapis.com:443"


async def stream_chat(live_chat_id):
    """gRPC streamList 로 채팅을 push 받아 (작성자, 텍스트) yield."""
    creds = grpc.ssl_channel_credentials()
    metadata = (("x-goog-api-key", API_KEY),)
    page_token = ""

    async with grpc.aio.secure_channel(HOST, creds) as channel:
        stub = stream_list_pb2_grpc.V3DataLiveChatMessageServiceStub(channel)
        # 바깥 while: 스트림이 한 번 끊겨도(네트워크 등) 마지막 page_token 으로 재연결.
        while True:
            request = stream_list_pb2.LiveChatMessageListRequest(
                part=["snippet", "authorDetails"],
                live_chat_id=live_chat_id,
                page_token=page_token,
            )
            # 안쪽 async for: 이 연결이 살아있는 동안 서버가 push 하는 응답들을 계속 받음.
            async for response in stub.StreamList(request, metadata=metadata):
                for item in response.items:
                    text = item.snippet.display_message
                    author = item.author_details.display_name
                    if text:
                        yield author, text
                if response.next_page_token:
                    page_token = response.next_page_token  # 다음 재연결 시 이어서 받기 위해 저장
                if response.offline_at:
                    return  # 방송 종료 → 스트림 끝. 재연결 불필요.


if __name__ == "__main__":
    import asyncio

    from youtube import get_live_chat_id

    async def main():
        chat_id = get_live_chat_id(sys.argv[1])
        async for author, text in stream_chat(chat_id):
            print(f"{author}: {text}")

    asyncio.run(main())