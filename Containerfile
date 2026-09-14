# ── Stage 1: extract Xtensa/RISC-V addr2line tools + decode scripts ──────────
FROM --platform=linux/amd64 docker.io/pjakobs/sming:latest AS sming-tools

RUN set -e; \
    source /opt/Sming/Tools/export.sh > /dev/null 2>&1; \
    mkdir -p /extract/tools; \
    for tool in xtensa-lx106-elf-addr2line xtensa-esp32-elf-addr2line riscv32-esp-elf-addr2line; do \
        bin=$(which $tool 2>/dev/null || find /opt -name "$tool" -type f 2>/dev/null | head -1); \
        if [ -z "$bin" ]; then \
            echo "ERROR: $tool not found in sming image" >&2; exit 1; \
        fi; \
        echo "Found $tool at $bin"; \
        cp "$bin" /extract/; \
    done; \
    cp /opt/Sming/Sming/Arch/Esp8266/Tools/decode-stacktrace.py /extract/tools/decode-esp8266.py; \
    cp /opt/Sming/Sming/Arch/Esp32/Tools/decode-stacktrace.py   /extract/tools/decode-esp32.py

# ── Stage 2: production service image ────────────────────────────────────────
FROM node:22 AS base

ENV NODE_ENV=production
WORKDIR /app
ARG GIT_VERSION=dev
ENV APP_VERSION=$GIT_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sming-tools /extract/xtensa-lx106-elf-addr2line  /usr/local/bin/
COPY --from=sming-tools /extract/xtensa-esp32-elf-addr2line  /usr/local/bin/
COPY --from=sming-tools /extract/riscv32-esp-elf-addr2line   /usr/local/bin/
COPY --from=sming-tools /extract/tools/ /app/tools/

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/data/logs /app/data/elfs

EXPOSE 4821/tcp
EXPOSE 5514/udp

CMD ["node", "src/index.js"]
