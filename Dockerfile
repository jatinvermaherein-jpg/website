# Railway build — the crew bus, on a host that never sleeps.
#
# This image does ONE job: serve the bus. It does not run agents, does not
# run a browser, and does not need a model key. A bus with no brain is still
# a bus; that is the whole point of splitting them.
#
# Monorepo-aware: build context is the repo root, because prisma/ and
# scripts/ live there and apps/api imports across.
FROM node:20-bookworm-slim AS build
WORKDIR /app

# the prisma engine needs these two at install time
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
RUN npm ci --workspace @jatin/api --include-workspace-root 2>/dev/null || npm install

COPY prisma ./prisma
COPY scripts ./scripts
COPY apps/api ./apps/api

# generate the client BEFORE the build — tsc fails on types that do not exist
RUN ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
RUN npm run build -w @jatin/api

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS run
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY package.json ./

# migrate on boot, then serve. A bus that is up but unbootstrapped answers
# 500s to a crew that cannot tell why.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma && node apps/api/dist/server.js"]

# Railway uses this to decide the container is alive. If /health stops
# answering, the platform restarts — which is exactly the behaviour a bus
# needs and a tunnel never had.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
