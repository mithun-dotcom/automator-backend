FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    DATA_DIR=/data \
    PORT=10000

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY extension ./extension
RUN mkdir -p /data

EXPOSE 10000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
