# syntax=docker/dockerfile:1
# Chew Network affiliate site — production image.
# Build:  docker build -t chew-affiliate .
# Run:    see docker-compose.yml (app + Caddy for automatic HTTPS)

# ---- 1. Install production dependencies ------------------------------------
# Build tools are only needed if better-sqlite3 has to compile from source;
# they stay in this stage and never reach the final image.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- 2. Runtime ---------------------------------------------------------------
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The database and uploaded Content Kitchen files live in /app/data (a volume).
# App code stays root-owned and read-only to the app user.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
