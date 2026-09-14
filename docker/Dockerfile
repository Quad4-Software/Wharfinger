# syntax=docker/dockerfile:1
# Pinned to a full digest for reproducible builds.
ARG NODE_IMAGE=node:26.8.2-alpine3.24@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868

# ---------- deps: install all dependencies with a cached pnpm store ----------
FROM ${NODE_IMAGE} AS deps
# Node 26 no longer ships corepack; install the pinned pnpm directly.
RUN npm install -g pnpm@11.24.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build: compile the SvelteKit app ----------
FROM deps AS build
COPY . .
RUN pnpm run build

# ---------- runtime: minimal, rootless ----------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="wharfinger" \
      org.opencontainers.image.description="Self-hosted ops platform: monitoring, status pages, deployments, and agents" \
      org.opencontainers.image.licenses="0BSD" \
      org.opencontainers.image.source="https://github.com/Quad4-Software/Wharfinger"
ENV NODE_ENV=production \
    WHARFINGER_CONFIG=/etc/wharfinger/wharfinger.toml \
    WHARFINGER_DATA_DIR=/var/lib/wharfinger \
    HOST=0.0.0.0 \
    PORT=3000

# node:alpine ships a 'node' user (uid 1000). Nothing here needs root.
# The pinned digest lags upstream fixes; upgrade openssl explicitly so
# CVE-2026-14456 (fixed in 3.5.8-r0) does not ship in the runtime image.
RUN mkdir -p /var/lib/wharfinger /etc/wharfinger \
    && chown -R node:node /var/lib/wharfinger \
    && apk upgrade --no-cache libcrypto3 libssl3
WORKDIR /app

# adapter-node output bundles all app runtime deps. The production
# server wrapper (server.js) adds the /ingress/ws upgrade bridge and
# needs only the ws package, which has no transitive dependencies.
# undici stays external to the bundle for its egress-guard Agent and
# has no transitive dependencies either.
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server.js ./server.js
COPY --from=build --chown=node:node /app/server ./server
COPY --from=deps --chown=node:node /app/node_modules/.pnpm/ws@*/node_modules/ws ./node_modules/ws
COPY --from=deps --chown=node:node /app/node_modules/.pnpm/undici@*/node_modules/undici ./node_modules/undici
COPY --chown=node:node config/wharfinger.toml /etc/wharfinger/wharfinger.toml

USER node
EXPOSE 3000

VOLUME ["/var/lib/wharfinger"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
