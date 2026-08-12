# ============================================================
#  Dockerfile — המנהל האישי (בוט המשימות בוואטסאפ)
#  כולל Chromium שדרוש ל-whatsapp-web.js
# ============================================================
# Node 22 — נדרש ע"י @supabase/supabase-js (WebSocket מובנה)
FROM node:22-slim

# Chromium + פונטים (כולל פונטים עבריים) + תעודות
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

# puppeteer לא יוריד Chromium משלו — נשתמש במותקן במערכת
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WA_SESSION_PATH=/data/.wwebjs_auth \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src

# החיבור לוואטסאפ נשמר כאן — חייב להיות דיסק קבוע, אחרת צריך לסרוק QR בכל הפעלה
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "src/index.js"]
