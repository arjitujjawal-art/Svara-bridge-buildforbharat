FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN --mount=type=secret,id=network_ca \
    if [ -f /run/secrets/network_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/network_ca; fi; \
    npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY infra/make_sample.py /tmp/make_sample.py
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng ffmpeg \
    && mkdir -p assets \
    && python /tmp/make_sample.py \
    && rm /tmp/make_sample.py \
    && apt-get purge -y ffmpeg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN --mount=type=secret,id=network_ca \
    if [ -f /run/secrets/network_ca ]; then export PIP_CERT=/run/secrets/network_ca; fi; \
    pip install --no-cache-dir -r requirements.txt
COPY --chown=65534:65534 api/ ./api/
COPY --from=web --chown=65534:65534 /src/web/dist ./web/dist
ENV PYTHONDONTWRITEBYTECODE=1
USER 65534
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--workers", "1", "--no-access-log", "--ws-max-size", "8192", "--ws-max-queue", "16"]
