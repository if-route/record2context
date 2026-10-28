# Headed Chromium under Xvfb, for suites that need a real display (Save dialogs) without opening a window on the host.
FROM mcr.microsoft.com/playwright:v1.61.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN mkdir /opt/pw && cd /opt/pw && npm init -y > /dev/null && npm install --no-audit --no-fund playwright@1.61.1
ENV PLAYWRIGHT_PATH=/opt/pw/node_modules/playwright/index.mjs R2C_E2E_HEADED=1
