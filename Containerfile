FROM node:22-alpine AS base

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install ansi-up && \
    npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/data/logs

EXPOSE 4821/tcp
EXPOSE 5514/udp

CMD ["node", "src/index.js"]
