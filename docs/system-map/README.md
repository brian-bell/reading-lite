# Reading Lite system map

Interactive overview of the reading pipeline, from the frontend Worker through
Worker intake, R2, Vectorize, and provider calls. It shows five flows: submit,
process, publish, retry/DLQ, and read. Select a building or flow for its payload
and source references.

The diagram omits separate D1/Durable Object buildings, budget admission,
digest delivery, and account teardown. Read [architecture](../architecture.md)
for those paths and the full write-order constraints. The drawn connections
show selected steps, not an atomic transaction across services.

## Open locally

```sh
# From the repository root
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs/system-map
```

Visit `http://127.0.0.1:8765/`. Flow tabs animate payloads; building selection
updates the explanation and source references. Drag the map to pan and
double-click to reset. Zone colors distinguish clients, processing, storage,
queues, and providers. Heights are illustrative, not measured capacity.
