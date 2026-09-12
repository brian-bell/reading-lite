# Docker Compose local dev

`docker compose up` runs the backend and `app/` Workers each in their own
container, giving an isolated, reproducible environment instead of whatever
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
host and gitignored). Local D1 data, R2 objects, and Wrangler's dev registry
persist in named volumes across `docker compose down` / `up`; `docker compose
down -v` clears them.

## Why one shared network namespace

The `BACKEND` service binding (`app/wrangler.jsonc`) resolves through
Wrangler's local dev registry, which records plain `127.0.0.1:<port>`
addresses — not container hostnames. `docker-compose.yml` gives `app`
`network_mode: "service:backend"` so both containers share one network stack,
and mounts a shared volume for `WRANGLER_REGISTRY_PATH` so both sides read the
same registry entries. Do not change `app`'s `network_mode` or split the
registry volume without re-verifying the binding still resolves.

## Seeding and sign-in

Both still work through the containers, using the same commands as the native
flow (see the skill), run against the published ports:

```sh
docker compose exec backend npm run seed:local
curl -s 'http://127.0.0.1:8787/api/dev/mailbox?email=founder%40localhost' | jq
```

## Limits

Same as native local dev: no Queue or Vectorize, so submit/import/reprocess
return 503 and vector similarity is empty. Editing `package.json` in either
project needs `docker compose build` (dependencies are baked into the image,
not reinstalled on every `up`); editing application source does not, since the
repository is bind-mounted and both dev servers hot-reload.
