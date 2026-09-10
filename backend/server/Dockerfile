FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/app/.hfcache \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 임베딩 모델을 이미지에 미리 구워둔다 → 런타임(콜드스타트) 때 다운로드 안 함
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('jhgan/ko-sroberta-multitask')"

COPY . .

# Cloud Run 은 PORT=8080, HF Spaces 는 7860. 둘 다 커버.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
