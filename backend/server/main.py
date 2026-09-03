import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from analyzer import analyze
from youtube import get_live_chat_id
from youtube_stream import stream_chat

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}

rooms = {}


class Room:
    def __init__(self, video_id):
        self.video_id = video_id
        self.clients = set()
        self.task = None

    async def run(self):
        chat_id = await asyncio.to_thread(get_live_chat_id, self.video_id)
        async for author, text in stream_chat(chat_id):
            msg = {
                "type": "analysis",
                "author": author,
                "text": text,
                "result": analyze(text),
            }
            for client in list(self.clients):
                try:
                    await client.send_json(msg)
                except Exception:
                    pass


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    req = await sock.receive_json()
    video_id = req["videoId"]

    room = rooms.get(video_id)
    if room is None:
        room = Room(video_id)
        rooms[video_id] = room
        room.task = asyncio.create_task(room.run())
    room.clients.add(sock)

    try:
        while True:
            data = await sock.receive_json()
            if data.get("type") == "backfill":
                for text in data.get("texts", []):
                    await sock.send_json({
                        "type":"analysis",
                        "author":"",
                        "text":text,
                        "result":analyze(text)
                    })
    except WebSocketDisconnect:
        pass
    finally:
        room.clients.discard(sock)
        if not room.clients:
            await asyncio.sleep(30)
            if not room.clients:
                if room.task:
                    room.task.cancel()
                rooms.pop(video_id, None)