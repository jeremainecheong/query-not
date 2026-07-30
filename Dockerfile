# query-not — one image, one process.
#
# The agent serves the built UI as well as the API, because the whole design is
# single-tenant and agent-side: one container inside your network, holding the
# database credential and the history store, with nothing to phone home to.
#
#   docker build -t query-not .
#   docker run -p 5174:5174 \
#     -e QUERYNOT_DATABASE_URL=postgres://readonly:pw@host:5432/db \
#     -v querynot-data:/data \
#     query-not

FROM node:22-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .

# The web build needs core's types; the agent runs core from source at runtime.
RUN npm run build --workspace @query-not/core \
 && npm run build --workspace @query-not/web

# ── Runtime ───────────────────────────────────────────────────────────────────

FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — the web build is already static.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/src packages/core/src
COPY --from=build /app/packages/agent/src packages/agent/src
COPY --from=build /app/packages/agent/bin packages/agent/bin
COPY --from=build /app/packages/web/dist packages/web/dist

# History lives on a volume; losing it on redeploy would lose every baseline.
ENV QUERYNOT_STORE_PATH=/data/store.db
VOLUME /data

# Never run as root against someone's database.
RUN useradd --system --uid 10001 querynot && mkdir -p /data && chown querynot /data
USER querynot

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:5174/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "--no-warnings", "packages/agent/src/server.ts"]
