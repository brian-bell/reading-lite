# Frontend Worker (app/) for `docker compose`. Not used for deployment — see
# docs/docker-compose.md.
FROM node:22-bookworm-slim

WORKDIR /workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 5174

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
