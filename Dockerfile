# Jatin API — one image, any Docker host.
# Render's free tier auto-detects this file (zero config).
# Multi-stage: dev deps and build tooling never ship in the runtime image.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/apps/api ./apps/api
EXPOSE 8080
# Migrations run at every instance start — idempotent, and a loud failure
# if the database is unreachable. Never a silent schema drift.
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && exec node apps/api/dist/server.js"]
