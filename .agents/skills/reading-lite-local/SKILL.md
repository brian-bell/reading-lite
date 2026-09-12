---
name: reading-lite-local
description: Start, stop, or troubleshoot reading-lite's local app/ frontend and backend together, retrieve local sign-in links, and optionally seed the sample library. Use for running this repository locally, not deployment or the legacy web/ SPA.
---

# reading-lite local development

Work in the current reading-lite checkout. Read its `AGENTS.md` and `app/README.md` for current commands and constraints. The frontend is `app/` on **127.0.0.1:5174**; the backend is the repository root on **8787**. Keep the same checkout for both so the Cloudflare service binding and local data agree.

## Start

1. Check Node (22.12+ required) and listeners on 5174 and 8787 with `lsof -nP -iTCP:5174 -iTCP:8787 -sTCP:LISTEN`. Inspect listener command lines and working directories before reusing them. Reuse healthy servers belonging to this checkout; do not kill an unrelated port owner or silently accept Vite moving to another port.
2. Install missing dependencies with `npm ci` in the root and/or `app/` as needed. An absent `@cloudflare/vite-plugin` means the frontend dependencies need installing.
3. Prepare local `.dev.vars`: copy `.dev.vars.example` only if the file does not exist. Otherwise preserve existing values and fill missing local bootstrap settings (`READER_API_TOKEN`, `AUTH_ROOT_SECRET`, `FOUNDER_EMAIL`) from the example. Never print secret values. Root `dev:setup` can exit 2 without explaining which bootstrap setting is missing; inspect key presence/nonempty values without exposing credentials. These example settings are for local development only.
4. Start the backend in a persistent exec session from the repository root:

   ```sh
   npm run dev -- --var WEB_BASE_URL:http://127.0.0.1:5174
   ```

   This applies local D1 migrations and bootstraps the local founder. The URL override makes magic links return to the new frontend instead of the legacy SPA on 5173.
5. Start the frontend in a separate persistent exec session with working directory `app/`:

   ```sh
   npm run dev
   ```

   Record both session IDs for shutdown. If sandbox restrictions prevent listening or tsx IPC, use the environment's normal escalation mechanism; do not change application code to bypass it.
6. Wait for readiness, then check all three paths. `http://127.0.0.1:8787/health` returns `ok`; `http://127.0.0.1:5174/api/auth/login-options` checks the Vite proxy that browser calls use; and an anonymous `http://127.0.0.1:5174/` checks the `BACKEND` service binding that server renders use, which the proxy does not cover:

   ```sh
   curl -s http://127.0.0.1:5174/ | grep -q account-sign-in && echo binding-ok
   ```

   A server render that cannot reach `BACKEND` still returns 200 with the shell, but treats identity as unknown and omits both the sign-in link and the account menu, so a 200 alone is not readiness. A missing marker means the backend is not in the Wrangler dev registry: confirm it is running from this checkout as `reading-lite-dev`, then restart the frontend after it. Report the frontend link and leave both processes running. Do not claim readiness from a startup banner alone.

## Sign in and seed

Request a magic link through the frontend login page. Fetch the local inbox with the email actually used (URL-encode it); the example founder is `founder@localhost`:

```sh
curl -s 'http://127.0.0.1:8787/api/dev/mailbox?email=founder%40localhost' | jq
```

Open the returned `verify_url`. Do not print local credentials unless the user requests the link, and never put bearer material in browser storage.

When the user wants sample readings, read `docs/design/connected/fixture-pack.md`, then run from the repository root:

```sh
npm run seed:local
```

The pack writes 18 authored sample readings into local R2, with ready, pending, and failed states. It replaces the local list index with fixture rows: do not reseed automatically on every startup or overwrite a populated custom library without accounting for the user's intent. Wait for the seeder's read-back verification and verify a ready reading through the running backend. The baseline detail link is `http://127.0.0.1:5174/readings/rd_FXATTENT01`. Refresh the browser after seeding; restart the backend only if necessary. The pending fixture ages out after 15 minutes.

Local dev has no Queue or Vectorize: submit/import/reprocess return 503 and vector similarity is empty. Seeding supplies UI data without provider calls. Keep all operations local; no production reads, writes, or deployment are needed.

## Stop

Stop both owned dev sessions with Ctrl-C when available. If session handles are unavailable, inspect listeners and their parent process commands/cwds; send TERM to this checkout's Vite and Wrangler CLI processes so their children shut down too. Do not use broad `pkill node`/`pkill workerd` commands. Confirm that both ports are no longer listening, and investigate surviving owned children before declaring shutdown complete. Preserve `.dev.vars`, dependencies, and local seeded data for the next run.
