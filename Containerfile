FROM node:22-bookworm AS decoder-tools
ARG TARGETARCH
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 binutils-xtensa-lx106 xz-utils \
    && rm -rf /var/lib/apt/lists/*
COPY config/decoder-toolchains.json ./config/decoder-toolchains.json
COPY scripts/install-decoder-tools.js scripts/test-decoder-tools.js ./scripts/
COPY tools/ ./tools/
RUN node scripts/install-decoder-tools.js /extract "$TARGETARCH"
ENV PATH="/extract/bin:${PATH}"
RUN node scripts/test-decoder-tools.js /extract/tools

# ── Stage 2: production service image ────────────────────────────────────────
FROM node:22-bookworm AS base

ENV NODE_ENV=production
WORKDIR /app
ARG GIT_VERSION=dev
ENV APP_VERSION=$GIT_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 binutils-xtensa-lx106 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=decoder-tools /extract/bin/ /usr/local/bin/
COPY --from=decoder-tools /extract/tools/ /app/tools/
COPY scripts/test-decoder-tools.js /app/scripts/test-decoder-tools.js
RUN node /app/scripts/test-decoder-tools.js

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/data/logs /app/data/elfs

EXPOSE 4821/tcp
EXPOSE 5514/udp

CMD ["node", "src/index.js"]
