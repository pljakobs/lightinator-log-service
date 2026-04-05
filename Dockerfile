# ── Stage 1: extract Xtensa/RISC-V addr2line tools + decode scripts ──────────
# The pjakobs/sming image has all ESP toolchains installed.
# We copy only the addr2line binaries and the two decode-stacktrace.py scripts
# so the final image stays small.
# Pin to linux/amd64: pjakobs/sming is amd64-only; Docker multi-stage allows
# using an amd64 build stage even when the final image targets arm64.
FROM --platform=linux/amd64 docker.io/pjakobs/sming:latest AS sming-tools

RUN bash -c " \
    source /opt/Sming/Tools/export.sh > /dev/null 2>&1; \
    mkdir -p /extract/tools; \
    for tool in xtensa-lx106-elf-addr2line xtensa-esp32-elf-addr2line riscv32-esp-elf-addr2line; do \
        bin=\$(which \$tool 2>/dev/null || find /opt /root /home -name \"\$tool\" -type f 2>/dev/null | head -1); \
        if [ -n \"\$bin\" ]; then \
            cp \"\$bin\" /extract/; \
        else \
            printf '#!/bin/sh\necho \"addr2line tool %s not available\" >&2; exit 1\n' \"\$tool\" > /extract/\$tool; \
            chmod +x /extract/\$tool; \
        fi; \
    done; \
    cp /opt/Sming/Sming/Arch/Esp8266/Tools/decode-stacktrace.py /extract/tools/decode-esp8266.py; \
    cp /opt/Sming/Sming/Arch/Esp32/Tools/decode-stacktrace.py   /extract/tools/decode-esp32.py"

# ── Stage 2: production service image ────────────────────────────────────────
# Use full Debian node image (not alpine) for glibc compatibility with the
# pre-built Espressif toolchain binaries.
FROM node:22 AS base

ENV NODE_ENV=production
WORKDIR /app
# Injected at build time by CI: e.g. develop-a1b2c3d
ARG GIT_VERSION=dev
ENV APP_VERSION=$GIT_VERSION

# Python3 is required to run decode-stacktrace.py
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

# addr2line binaries from Sming toolchains
COPY --from=sming-tools /extract/xtensa-lx106-elf-addr2line  /usr/local/bin/
COPY --from=sming-tools /extract/xtensa-esp32-elf-addr2line  /usr/local/bin/
COPY --from=sming-tools /extract/riscv32-esp-elf-addr2line   /usr/local/bin/

# decode-stacktrace.py scripts (one per architecture)
COPY --from=sming-tools /extract/tools/ /app/tools/

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/data/logs /app/data/elfs

EXPOSE 4821/tcp
EXPOSE 5514/udp

CMD ["node", "src/index.js"]
