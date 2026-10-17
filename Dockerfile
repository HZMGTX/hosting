# OmniHost — production image (Railway, Render, Fly.io, any Docker host).
FROM node:24-bookworm-slim

# git: GitHub deploys · python3 + venv + pip: Python bots · tini: proper signal handling for child processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js db.js docker-entrypoint.sh ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# All state (services, database, logs, backups) lives in /data — mount a persistent volume there.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/home/node
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app /home/node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Starts as root only to fix volume permissions, then drops to the "node" user (see docker-entrypoint.sh).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
