FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_USER_DATA_DIR=/data/chrome \
    CHROME_PROFILE_DIR=Default \
    LIGHTPANDA_PATH=/usr/local/bin/stealthpanda

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    python3-websockify \
    ca-certificates \
    curl \
    fonts-dejavu \
    fonts-liberation \
    fonts-noto-color-emoji \
    mupdf-tools \
    && rm -rf /var/lib/apt/lists/*

# Install Stealth Panda (fork of Lightpanda)
RUN curl -fsSL "https://github.com/evan108108/StealthPanda/releases/download/v1.0.2/stealthpanda-x86_64-linux" -o /usr/local/bin/stealthpanda && \
    chmod +x /usr/local/bin/stealthpanda

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh && mkdir -p /data/chrome

EXPOSE 1995 1996 1994

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/mcp-server.js"]
