# reading-lite

Personal reading service on Cloudflare Workers. Submit a URL → Claude summarizes it → store on R2 + Vectorize. Async via `ctx.waitUntil()`, polled via `GET /readings/:id`.

See [`plans/001-prd-reading-lite.md`](plans/001-prd-reading-lite.md) for the full PRD and [`plans/000-re-design.md`](plans/000-re-design.md) for the original design memo.

## Status

Greenfield, in progress. Tracked at [issue #1](https://github.com/brian-bell/reading-lite/issues/1).

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in API keys
npm run dev                      # wrangler dev with R2 + Vectorize bindings
npm test                         # vitest + miniflare
npm run typecheck
```

You'll need staging R2 + Vectorize resources first:

```sh
npx wrangler r2 bucket create reading-lite-dev
npx wrangler vectorize create reading-lite-dev --dimensions=1536 --metric=cosine
```

Then update `wrangler.toml` `preview_bucket_name` and the Vectorize `index_name` accordingly.

## API

| Method + path | Auth | Behavior |
|---|---|---|
| `GET /health` | none | 200 OK |
| `POST /readings` | bearer | 202 with `{ id, status }`; background work fills the manifest. |
| `GET /readings` | bearer | Paginated newest-first list. |
| `GET /readings/:id` | bearer | Manifest. |
| `GET /readings/:id/content` | bearer | Extracted markdown. |
| `GET /readings/:id/content/raw` | bearer | Raw bytes. |
| `GET /readings/lookup?url=` | bearer | `{ id }` or 404. |
| `POST /readings/similar` | bearer | Top-K similar via Vectorize. |

All protected routes require `Authorization: Bearer $READER_API_TOKEN`.

## Migration

A one-shot script backfills readings from a Backlite SQLite snapshot:

```sh
npm run migrate -- --sqlite ./backlite.db --content-dir ./backlite-data \
                   --bucket reading-lite-dev --index reading-lite-dev
```

The script is read-only against Backlite and idempotent against the target.
