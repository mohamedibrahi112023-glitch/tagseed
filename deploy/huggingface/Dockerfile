# Dockerfile خاص بـ Hugging Face Spaces: بيسحب الكود من GitHub ويبنيه.
# بعد أي تحديث على GitHub: Settings في الـ Space ← Factory rebuild.

FROM node:22-alpine AS src
RUN apk add --no-cache git && git clone --depth 1 https://github.com/mohamedibrahi112023-glitch/tagseed.git /src

# 1) بناء الواجهة
FROM node:22-alpine AS web
WORKDIR /app/frontend
COPY --from=src /src/frontend/package.json /src/frontend/package-lock.json ./
RUN npm ci
COPY --from=src /src/frontend/ ./
RUN npm run build

# 2) الخادم (Hugging Face بيشغّل الحاوية كمستخدم رقم 1000، فلازم /data تبقى قابلة للكتابة)
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    ENV=production \
    DB_PATH=/data/tagseed.db \
    FRONTEND_DIST=/app/frontend/dist \
    MODEL_FAST=gemini-3.5-flash-lite \
    MODEL_BALANCED=gemini-3-flash-preview \
    MODEL_STRONG=gemini-3-flash-preview
COPY --from=src /src/backend/requirements.txt backend/
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY --from=src /src/backend/ backend/
COPY --from=web /app/frontend/dist frontend/dist
RUN mkdir -p /data && chmod 777 /data
EXPOSE 7860
CMD uvicorn main:app --app-dir backend --host 0.0.0.0 --port 7860 --proxy-headers --forwarded-allow-ips="*"
