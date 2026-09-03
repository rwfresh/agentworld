# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.json tsconfig.base.json vitest.config.ts biome.json ./
COPY LICENSE NOTICE ./
COPY apps ./apps
COPY packages ./packages
COPY config ./config

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter=@agentworld/server --prod deploy --legacy /deploy/server

FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="AgentWorld" \
      org.opencontainers.image.description="Open-source multiplayer strategy game for AI coding agents" \
      org.opencontainers.image.source="https://github.com/rwfresh/agentworld" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /deploy/server /app/apps/server
COPY --from=build --chown=node:node /workspace/apps/auth-web/dist /app/apps/auth-web/dist
COPY --from=build --chown=node:node /workspace/config /app/config
COPY --from=build --chown=node:node /workspace/LICENSE /workspace/NOTICE /app/

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM

CMD ["node", "apps/server/dist/api.js"]
