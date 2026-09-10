# Dev image for the Navigator Browser Relay Chrome extension.
# A dedicated Chromium (independent of navigator's server Chromium) for
# developing and testing the extension in a headed browser.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    xauth \
    dbus \
    curl \
    python3 \
    x11vnc \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# The extension source is mounted at /app/extension (see docker-compose.yml).
RUN mkdir -p /app/extension /app/scripts
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh

EXPOSE 9222 5900
ENV DISPLAY=":99"
ENTRYPOINT ["/app/scripts/entrypoint.sh"]
