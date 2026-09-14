# ⚠️ 레거시 — 지금 서버는 이 코드를 쓰지 않습니다

`prep.py`, `train.py`, 그리고 `../model/*.pkl`은 **SBERT 임베딩 + 로컬 회귀 모델**로
욕설/성적/정치를 분류하던 시절(커밋 `605e7ed`)의 학습 파이프라인입니다.

이후 무료로 배포할 방법을 찾다가(카드 없는 호스팅은 대부분 RAM/CPU가 SBERT를
못 버팀) `analyzer.py`를 **OpenAI Moderation API + 키워드 사전** 방식으로 갈아탔고
(`ac98162`), 이 폴더는 그때부터 실행되지 않습니다.

## 왜 안 지웠나

- `model/*.pkl`은 파일이 작고(각 6.8KB), 나중에 다시 로컬 AI로 돌아가거나
  (예: 정치 카테고리를 AI로 판정하고 싶어질 때) 참고할 수 있어서 보존
- 파이프라인 구조(임베딩 → 회귀 학습 → pkl 저장) 자체는 재사용 가능한 패턴

## 내용 요약 (참고용)

- `prep.py`: `jhgan/ko-sroberta-multitask`로 라벨링된 문장 20만+개를 임베딩해
  `data/embeddings.npy` + `data/labels.parquet` 생성 (안 커밋, `.gitignore`)
- `train.py`: 위 임베딩으로 `LogisticRegression` 3개(profanity/sexual/political)
  학습 → `model/*.pkl`
- 실행하려면 `sentence-transformers`, `torch`, `scikit-learn`이 필요한데
  현재 `requirements.txt`에는 없음(서버가 안 써서 뺐음) — 다시 쓰려면
  별도로 설치해야 함
