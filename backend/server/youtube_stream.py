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
        while True:
            request = stream_list_pb2.LiveChatMessageListRequest(
                part=["snippet", "authorDetails"],
                live_chat_id=live_chat_id,
                page_token=page_token,
            )
            async for response in stub.StreamList(request, metadata=metadata):
                for item in response.items:
                    text = item.snippet.display_message
                    author = item.author_details.display_name
                    if text:
                        yield author, text
                if response.next_page_token:
                    page_token = response.next_page_token
                if response.offline_at:
                    return


if __name__ == "__main__":
    import asyncio

    from youtube import get_live_chat_id

    async def main():
        chat_id = get_live_chat_id(sys.argv[1])
        async for author, text in stream_chat(chat_id):
            print(f"{author}: {text}")

    asyncio.run(main())