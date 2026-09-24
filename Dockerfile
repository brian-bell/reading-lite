# Backend Worker (repository root) for `docker compose`. Not used for
# deployment — see docs/docker-compose.md. Mirrors the Node floor `npm run dev`
# enforces itself (scripts/require-dev-node.ts).
FROM node:22-bookworm-slim

WORKDIR /workspace

# Native optional dependencies (better-sqlite3 for the D1-era test fixtures)
# need a build toolchain when no prebuilt binary matches; keep it available so
# `npm ci` does not fail on an image rebuild.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 8787

CMD ["sh", "-c", "test -f .dev.vars || cp .dev.vars.example .dev.vars; npm run dev -- --ip 0.0.0.0 --var WEB_BASE_URL:http://localhost:5174"]
