# Docker Compose local dev

`docker compose up` runs PostgreSQL plus the backend and `app/` Workers each in
their own container, giving an isolated, reproducible environment instead of whatever
Node/npm state happens to be on the host. This is an alternative to the native
flow — `npm run dev` plus `cd app && npm run dev`, or the
[reading-lite-local](../.agents/skills/reading-lite-local/SKILL.md) skill —
which remains the default and is unaffected by this file. Not used for
deployment; both images run `wrangler dev` / `vite dev`, never a build.

## Start

```sh
docker compose up --build
```

- Backend: `http://localhost:8787`
- App: `http://localhost:5174`

The first run needs `.dev.vars` at the repository root; copy it from
`.dev.vars.example` if you have not already (the backend container does this
itself on first boot if the file is missing, since it is bind-mounted from the
host and gitignored). Local D1 data, R2 objects, PostgreSQL data, and
Wrangler's dev registry persist in named volumes across `docker compose down` / `up`; `docker compose
down -v` clears them.

## PostgreSQL

The `postgres` service is PostgreSQL 18 with pgvector 0.8.x, matching Neon
([ADR 0005](decisions/0005-postgresql-storage.md)). `backend` waits for its
health check, then `npm run dev` migrates it; there is no Docker inside the
container, so `READING_LITE_DATABASE_URL` marks the database as self-managed and
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` points the Worker's
`HYPERDRIVE` binding at `postgres:5432` instead of the host port in
`wrangler.toml`. The service is also published on host port **54329** for the
native flow and the test suite, which start it alone with
`docker compose up -d postgres`. `docker-compose.yml` maps to no CI job, so
check this wiring by hand after changing it.

## Why one shared network namespace

The `BACKEND` service binding (`app/wrangler.jsonc`) resolves through
Wrangler's local dev registry, which records plain `127.0.0.1:<port>`
addresses — not container hostnames. `docker-compose.yml` gives `app`
`network_mode: "service:backend"` so both containers share one network stack,
and mounts a shared volume so both sides read the same registry entries. Do
not change `app`'s `network_mode` or split the registry volume without
re-verifying the binding still resolves.

The two dev servers read that shared registry through two different env vars
for the same setting: the backend's plain `wrangler dev` writes its entry
under `WRANGLER_REGISTRY_PATH`, but `app`'s `@cloudflare/vite-plugin` resolves
it through the `miniflare` package's own default, governed by
`MINIFLARE_REGISTRY_PATH`. Both are set to the same path in `app`'s
environment; dropping either one makes the binding resolve to "not found."

## The BACKEND binding needs ~1–2 minutes to warm up

After a cold `docker compose up`, the anonymous `/` readiness check (see the
skill) can keep failing — `account-sign-in` missing, identity treated as
unknown — for roughly 70–120 seconds even though both `/health` and the Vite
proxy already work. This traces to Miniflare's dev-registry client
(`WORKER_HEARTBEAT_MS` / `WORKER_STALE_MS` in `miniflare/dist/src/index.js`),
not to anything this compose file controls: the first attempts to reach the
backend's debug-port RPC channel fail with "Network connection lost" until
enough heartbeats have passed. Restarting `app` does not shorten this — only
elapsed wall-clock time since the backend started does. Wait it out (poll the
skill's binding check) rather than restarting anything; a warm, already-running
backend does not have this delay when only `app` restarts.

## Seeding and sign-in

Both still work through the containers, using the same commands as the native
flow (see the skill), run against the published ports:

```sh
docker compose exec backend npm run seed:local   # R2 and PostgreSQL
curl -s 'http://127.0.0.1:8787/api/dev/mailbox?email=founder%40localhost' | jq
```

## Limits

Same as native local dev: no Queue or Vectorize, so submit/import/reprocess
return 503 and vector similarity is empty. Editing `package.json` in either
project needs `docker compose build` (dependencies are baked into the image,
not reinstalled on every `up`); editing application source does not, since the
repository is bind-mounted and both dev servers hot-reload.
