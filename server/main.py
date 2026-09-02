import asyncio
import random 

from fastapi import FastAPI, WebSocket

from analyzer import analyze

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}

# --- 임시 가짜 채팅 (오후 4시 할당량 리셋되면 streamList로 교체) ---
SAMPLES = [
    ("정상러", "오늘 방송 진짜 재밌어요"),
    ("도배러", "ㅋㅋㅋㅋㅋㅋㅋㅋㅋ"),
    ("욕쟁이", "씨발 존나 노잼이네"),
    ("정치충", "이번 선거는 여당이 이긴다"),
    ("변태", "저 스트리머 몸매 지린다"),
]

async def fake_chat():
    while True:
        await asyncio.sleep(1.5)
        yield random.choice(SAMPLES)

@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    await sock.receive_json()       # 확장이 {"videoId": "..."} 보냄 (지금은 무시)
    async for author, text in fake_chat():
        await sock.send_json({
            "type": "analysis",
            "author": author,
            "text": text,
            "result": analyze(text),
        })
