# Jatin API — one image, any Docker host.
# Render's free tier auto-detects this file (zero config).
# Multi-stage: dev deps and build tooling never ship in the runtime image.

FROM node:20-slim AS build
# openssl must be present at GENERATE time too — Prisma picks the query
# engine (debian-openssl-3.0.x vs 1.1.x) based on what it detects here, and
# the runtime stage has openssl 3.x. Mismatched stages = "could not locate
# the Query Engine" on every query.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-slim
# Prisma's query engine needs libssl, which node:20-slim does not ship.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/apps/api ./apps/api
# the web build ships too: hitting the API host at / serves the real site
# (Netlify is the primary host; this is the fallback that keeps the link live)
COPY --from=build /app/apps/web ./apps/web
EXPOSE 8080
# Migrations run at every instance start — idempotent, and a loud failure
# if the database is unreachable. Never a silent schema drift.
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && exec node apps/api/dist/server.js"]
