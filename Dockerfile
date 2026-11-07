# Railway — the crew bus. Dependency-free: stdlib HTTP + crewcore.mjs only.
# No Prisma, no Supabase, no TypeScript build step. `node src/crew-api.mjs`
# and it is up.
#
# State lives in crew/board.json and is committed back to git on every write
# (gated by CREW_GIT_REMOTE), so the repo is the only memory and survives
# redeploys, restarts and power cuts.

FROM node:20-bookworm-slim
WORKDIR /app

# git is needed so the bus can push board.json back to the repo (the memory)
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

# copy only what the bus needs
COPY src/ ./src/
COPY crew/ ./crew/
COPY package.json ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/crew-api.mjs"]
