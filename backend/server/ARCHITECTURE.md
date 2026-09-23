# 서버 구조

## 데이터 흐름

```
확장(content.js) ──WS 연결──▶ main.py:ws() ──▶ Room 생성/조회
                                                 │
                                    ① 확장이 DOM(MutationObserver)으로 관찰한 채팅을
                                       계속 push: {"type":"chat","author","text"}
                                          Room._ingest_live_chat() 이 (작성자,텍스트)
                                          기준 중복 제거 후 버퍼에 쌓음
                                                 │ 1.2초마다 (FLUSH_INTERVAL)
                                          Room._flush()
                                                 │
                                    ② 버퍼에 쌓인 채팅을 한 번에 분석
                                          ┌──────▼───────┐
                                          │ analyzer.py   │
                                          │ analyze_batch │
                                          └──────┬────────┘
                                                 │ [{normal,profanity,political,sexual,spam}, ...]
                                    ③ 같은 Room 을 보는 모든 클라이언트에 broadcast
                                                 │
확장(content.js) ◀──WS──────────────────────────┘
   (여기서부터는 클라이언트가 임계값 비교해서 블러/숨김 결정 — 서버는 점수만 줌)
```

YouTube API(REST/gRPC)는 전혀 쓰지 않는다 — 채팅은 서버가 유튜브에서 직접 받아오는
게 아니라, 확장이 이미 실시간 필터링을 위해 관찰 중인 DOM 채팅을 서버로 올려주는
것뿐이다. 그래서 `YOUTUBE_API_KEY`도, API 쿼터 개념도 없다.

## 핵심 설계 결정 하나: Room = 방송 단위 공유

같은 방송(videoId)을 100명이 봐도:
- 채팅 1건당 `analyze_batch()` 호출은 **1번** (100명 몫이 아니라 — 100명이 각자
  DOM에서 같은 채팅을 관찰해서 중복으로 올려도 Room이 걸러냄)
- 방송요약/핫토픽 LLM 호출도 방송당 1번
- 결과만 100명에게 fan-out

인스턴스가 여러 개로 늘어나면(수평 확장) 이 가정이 깨지므로 지금은
`max-instances=1`로 고정해뒀다 (Render 배포 설정, 이 레포 밖).

## 파일별 책임

| 파일 | 책임 | 이 파일이 **아닌** 것 |
|---|---|---|
| `main.py` | WebSocket 프로토콜, Room(방송당 상태) 관리, 배치 flush 스케줄링, 악용 안전망(videoId 검증/상한/backfill 제한) | 유해한지 어떻게 판정하는지(→analyzer) |
| `analyzer.py` | 채팅 텍스트 → 항목별 0~100 점수 (Moderation API + 키워드 하이브리드) | WebSocket, Room 전부 무관 — 순수 함수형 |
| `train/` | ⚠️ 레거시 — 지금 서버가 안 씀, `train/README.md` 참고 | - |

## 왜 이렇게 나눴나

`main.py`가 "언제 누구에게 보낼지"만 알고, `analyzer.py`가 "이 텍스트가 얼마나
유해한지"만 알도록 분리했다. 필터 기준(키워드 추가, Moderation 대신 다른 API로
교체 등)을 바꿀 때 `analyzer.py`만 건드리면 되고, 반대로 방 관리 로직을 바꿀 때
필터 판정 코드를 볼 필요가 없다.

(예전엔 서버가 YouTube REST(`youtube.py`)/gRPC(`youtube_stream.py`)로 직접 채팅을
받아왔는데, 그때마다 YouTube API 일일 쿼터를 소모해서 자주 소진되는 문제가 있었다.
실시간 필터링 자체는 이미 확장이 DOM을 직접 관찰해서 하고 있었기 때문에, 서버도
그 DOM 관찰 결과를 받는 걸로 바꿔서 API 의존 자체를 없앴다.)

## 실행

```bash
cd backend/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# .env 에 OPENAI_API_KEY 필요 (Moderation API 사용 시)
.venv/bin/uvicorn main:app --reload
curl localhost:8000/health   # {"status":"ok"}
```
