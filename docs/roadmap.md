# FilterMe 구현 로드맵

## 구조

YouTube  ──(streamList, 실시간 push)──▶  서버 (FastAPI)
                                          │ AI가 채팅마다 항목별 점수(0~100) 분석
서버  ◀────────(WebSocket, 방송 단위 방)────────▶  확장 프로그램 (MV3)
                                          │ 켠 항목 점수 >= 임계값 이면 채팅 DOM 숨김

- YouTube 구간: 단방향 실시간 스트리밍
- 서버는 방송(방)마다 한 번만 분석 → 같은 방 사용자들에게 broadcast
- 필터 판정은 클라이언트에서 (서버는 점수만 제공)

## 필터 규칙

- 팝업에 항목별 on/off 토글 4개: 도배 / 욕설 / 비방·공격 / 광고·홍보
- 켠 항목만 동작
- 판정: `토글 ON` 그리고 `점수 >= 임계값(상수, 예: 70)` → 숨김
- 분석 결과 스키마: `{ "spam": 0-100, "profanity": 0-100, "aggression": 0-100, "advertising": 0-100 }`

## 단계

분석 모델(군집화 기반)은 11단계에서 구축. 그전까지는 규칙 기반 mock으로 전체 흐름 완성.

### Phase A — 백엔드 기초
- [ ] 1. FastAPI 셋업 + `GET /health`
- [ ] 2. mock 분석 `POST /analyze` (항목별 0~100 점수 리턴)
- [ ] 3. WebSocket `/ws` (더미 push)

### Phase B — YouTube 채팅 수신
- [ ] 4. GCP 프로젝트 + YouTube Data API v3 키
- [ ] 5. `liveChatMessages.list` 폴링으로 채팅 받아 콘솔 출력
- [ ] 6. 수신 → mock 분석 → WebSocket으로 방에 broadcast

### Phase C — 확장 프로그램
- [ ] 7. Manifest V3 + 채팅 DOM 감지 (콘솔 로그)
- [ ] 8. 백엔드 WebSocket 연결 (videoId로 방 입장, 결과 수신)
- [ ] 9. 작성자+텍스트 매칭 → 임계값 넘으면 숨김 (토글 전부 ON 가정)
- [ ] 10. 팝업 토글 UI + `chrome.storage`, 켠 항목만 판정

### Phase D — AI & 다듬기
- [ ] 11. mock → 군집화 모델 (임베딩 → 클러스터링 → 군집 라벨링 → 거리 기반 점수)
- [ ] 12. 폴링 → `streamList` server-streaming 교체
- [ ] 13. 도배 감지 강화 (시간창 내 유사 채팅 추적)

## 매칭 한계

서버는 YouTube messageId 를 갖지만 확장 DOM 엔 없음 → `작성자 + 텍스트(+대략 시각)` 로 매칭.
동일 문구 도배는 개별 구분 어려우나 어차피 같이 숨기면 되므로 문제 없음.

## 각 단계 완료 기준

- 1: `curl localhost:8000/health` → `{"status":"ok"}`
- 2: `curl -X POST .../analyze -d '{"message":"..."}'` → 점수 JSON
- 3: wscat 접속 → watch 전송 → ack + 더미 메시지
- 5: 실제 라이브 영상 ID로 채팅이 콘솔에 실시간 출력
- 6: wscat 에서 watch → 실제 채팅 + 점수 흘러나옴
- 7: 라이브 영상 열면 콘솔에 채팅 계속 로그
- 8: 확장 콘솔에 백엔드 분석 결과 출력
- 9: 방송에서 욕설/광고 채팅이 화면에서 사라짐
- 10: 욕설 토글만 켜면 욕설 채팅만 사라지고, 끄면 복구
