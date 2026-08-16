# reading-lite isometric system map

Interactive architecture map of the Cloudflare edge district: SPA, Worker
control plane, queues, R2, Vectorize, and provider towers.

## Open

```sh
# from repo root
python3 -m http.server 8765 --directory docs/system-map
# then visit http://127.0.0.1:8765/
```

Or open `docs/system-map/index.html` directly in a browser.

## What it shows

- **Buildings** — infrastructure modules with zone colors (client, control,
  store, index, queue, pipeline, external). Click for explainer + file cites.
- **Flow tabs** — five real control/data paths with animated payload traces:
  1. Submit & claim
  2. Process pipeline
  3. Terminal publish
  4. Retry & DLQ
  5. Read path
- **Legend + explainer panel** — hop payloads and source file cites update
  with selection.

Mapped against `main` modules cited in each building and flow.
