FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn==22.0.0

COPY . .

RUN mkdir -p data logs static

EXPOSE 5000
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

ENV BOT_TOKEN=""
ENV ADMIN_IDS=""
ENV FLASK_SECRET=""
ENV PORT=5000

CMD ["python3", "app.py"]
