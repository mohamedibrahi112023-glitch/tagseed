# 1) بناء الواجهة
FROM node:22-alpine AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# 2) الخادم، وبيقدّم الواجهة المبنية على نفس الرابط
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    ENV=production \
    DB_PATH=/data/tagseed.db \
    FRONTEND_DIST=/app/frontend/dist
COPY backend/requirements.txt backend/
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=web /app/frontend/dist frontend/dist
EXPOSE 8000
# --proxy-headers: علشان نعرف IP المستخدم الحقيقي ورا بروكسي الاستضافة (حد التسجيل لكل جهاز)
CMD uvicorn main:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips="*"
