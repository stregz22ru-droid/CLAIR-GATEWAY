# ── CLAIR Gateway — multi-stage production image ─────────────────────────────
# Build from the repository root:
#   docker build -f docker/Dockerfile -t clair-gateway .
# Or simply: docker compose up --build

# ── Stage 1: build TypeScript → dist/ ────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: slim runtime with production dependencies only ──────────────────
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/logs && chown -R node:node /app
USER node
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY package.json ./
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/health" >/dev/null 2>&1 || exit 1
CMD ["node", "dist/main.js"]
