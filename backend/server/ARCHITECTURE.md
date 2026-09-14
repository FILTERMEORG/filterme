# 서버 구조

## 데이터 흐름

```
                                          ① videoId 로 liveChatId 조회 (REST, 1회)
                                          ┌──────────────┐
                                          │  youtube.py  │
                                          └──────┬───────┘
                                                 │
확장(content.js) ──WS 연결──▶ main.py:ws() ──▶ Room 생성/조회
                                                 │
                                    ② liveChatId 로 실시간 채팅 수신 (gRPC, 상시 연결)
                                          ┌──────▼─────────────┐
                                          │ youtube_stream.py   │
                                          │ stream_chat()       │
                                          └──────┬──────────────┘
                                                 │ (author, text) 계속 yield
                                          Room._recv() 가 버퍼에 쌓음
                                                 │ 1.2초마다 (FLUSH_INTERVAL)
                                          Room._flush()
                                                 │
                                    ③ 버퍼에 쌓인 채팅을 한 번에 분석
                                          ┌──────▼───────┐
                                          │ analyzer.py   │
                                          │ analyze_batch │
                                          └──────┬────────┘
                                                 │ [{normal,profanity,political,sexual,spam}, ...]
                                    ④ 같은 Room 을 보는 모든 클라이언트에 broadcast
                                                 │
확장(content.js) ◀──WS──────────────────────────┘
   (여기서부터는 클라이언트가 임계값 비교해서 블러/숨김 결정 — 서버는 점수만 줌)
```

## 핵심 설계 결정 하나: Room = 방송 단위 공유

같은 방송(videoId)을 100명이 봐도:
- gRPC `streamList` 연결은 **1개** (`Room.run()`)
- 채팅 1건당 `analyze_batch()` 호출도 **1번** (100명 몫이 아니라)
- 결과만 100명에게 fan-out

→ 비용/할당량이 "동시 시청자 수"가 아니라 "동시에 필터링 중인 방송 수"에 비례한다.
인스턴스가 여러 개로 늘어나면(수평 확장) 이 가정이 깨지므로 지금은
`max-instances=1`로 고정해뒀다 (Render 배포 설정, 이 레포 밖).

## 파일별 책임

| 파일 | 책임 | 이 파일이 **아닌** 것 |
|---|---|---|
| `main.py` | WebSocket 프로토콜, Room(방송당 상태) 관리, 배치 flush 스케줄링, 악용 안전망(videoId 검증/상한/backfill 제한) | 채팅을 어떻게 받아오는지(→youtube_stream), 유해한지 어떻게 판정하는지(→analyzer) |
| `youtube_stream.py` | gRPC `streamList` 로 실시간 채팅 수신 | liveChatId를 어떻게 구하는지(→youtube), Room 관리 |
| `youtube.py` | REST로 videoId → liveChatId 조회 (`get_live_chat_id`) | 실시간 채팅 수신 (그건 streamList) |
| `analyzer.py` | 채팅 텍스트 → 항목별 0~100 점수 (Moderation API + 키워드 하이브리드) | WebSocket, Room, YouTube API 전부 무관 — 순수 함수형 |
| `stream_list_pb2*.py` | `.proto` 컴파일 산출물 (건드리지 않음) | - |
| `train/` | ⚠️ 레거시 — 지금 서버가 안 씀, `train/README.md` 참고 | - |

## 왜 이렇게 나눴나

`main.py`가 "언제 누구에게 보낼지"만 알고, `analyzer.py`가 "이 텍스트가 얼마나
유해한지"만 알도록 분리했다. 필터 기준(키워드 추가, Moderation 대신 다른 API로
교체 등)을 바꿀 때 `analyzer.py`만 건드리면 되고, 반대로 방 관리·재연결 로직을
바꿀 때 필터 판정 코드를 볼 필요가 없다.

`youtube.py` / `youtube_stream.py` 분리는 역사적 이유가 크다 — 처음엔 REST
폴링(`youtube.py`)만 있다가 할당량 문제로 gRPC 스트리밍(`youtube_stream.py`)을
추가했고, 폴링 코드는 CLI 테스트용으로 남겨뒀다.

## 실행

```bash
cd backend/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# .env 에 YOUTUBE_API_KEY, OPENAI_API_KEY 필요
.venv/bin/uvicorn main:app --reload
curl localhost:8000/health   # {"status":"ok"}
```
