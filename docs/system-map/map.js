/**
 * reading-lite isometric system map
 * Building placement and flows are derived from the Worker/frontend architecture
 * described in docs/architecture.md and the modules cited on each node.
 */

const TILE_W = 54;
const TILE_H = 31;
const ORIGIN_X = 520;
const ORIGIN_Y = 120;

function isoToScreen(gx, gy, gz = 0) {
  return {
    x: ORIGIN_X + (gx - gy) * (TILE_W / 2),
    y: ORIGIN_Y + (gx + gy) * (TILE_H / 2) - gz,
  };
}

/** @typedef {"client"|"control"|"store"|"index"|"queue"|"external"|"pipeline"} Zone */

/**
 * @type {Array<{
 *   id: string,
 *   name: string,
 *   gx: number,
 *   gy: number,
 *   w: number,
 *   h: number,
 *   depth: number,
 *   zone: Zone,
 *   variant: string,
 *   blurb: string,
 *   cites: string[],
 *   payload?: string
 * }>}
 */
const BUILDINGS = [
  {
    id: "spa",
    name: "Frontend Worker",
    gx: 1,
    gy: 8,
    w: 70,
    h: 58,
    depth: 52,
    zone: "client",
    variant: "pavilion",
    blurb:
      "TanStack Start frontend (app/) on its own Worker. Uses a host-only magic-link session cookie and CSRF tokens for writes. Lists/searches readings, submits URLs, opens content, and starts reprocesses. Invalidates queries after writes without polling pending readings.",
    cites: ["app/src/api/client.ts", "app/src/api/save.ts", "app/src/server/backend-reads.ts"],
    payload: `Cookie: __Host-session=…\nX-CSRF-Token: …  // writes\nGET /api/readings?q=&tag=\nPOST /api/readings { url, email? }`,
  },
  {
    id: "worker",
    name: "Worker gate",
    gx: 3,
    gy: 6,
    w: 58,
    h: 110,
    depth: 48,
    zone: "control",
    variant: "tower",
    blurb:
      "The fetch handler mounts Hono. Queue dispatch separates reading, digest, wipe, and relationship-refresh jobs and their DLQs; cron handles digest and wipe fan-out and the nightly refresh. Reading rate limits retry with delay; lease/budget denial defers paid work.",
    cites: ["src/index.ts", "src/router.ts", "wrangler.toml"],
    payload: `Env bindings:\nHYPERDRIVE · READINGS_BUCKET\nREADING_JOBS · DIGEST_JOBS\nACCOUNT_WIPE_JOBS\nRELATIONSHIP_REFRESH_JOBS\nusage guards · secrets/vars`,
  },
  {
    id: "claim",
    name: "Claim hall",
    gx: 5,
    gy: 5,
    w: 62,
    h: 78,
    depth: 50,
    zone: "control",
    variant: "hall",
    blurb:
      "URL ownership is one unique reading_urls row per tenant, committed with the pending reading, its attempt, and its job in one transaction. Outcomes: claimed | owned | tenant_inactive. Submit/import claim eagerly; lookup stays one side-effect-free read.",
    cites: ["src/intake/index.ts", "src/modules/stores/postgres/reading-writer.ts", "src/router.ts"],
    payload: `claimUrl(pending, keyPrefix, attempt)\n→ claimed\n→ owned { ownerId }\n→ tenant_inactive`,
  },
  {
    id: "activate",
    name: "Activation stack",
    gx: 7,
    gy: 4,
    w: 66,
    h: 86,
    depth: 54,
    zone: "control",
    variant: "stack",
    blurb:
      "Canonical eager write-and-enqueue: import artifacts to R2 first → committed claim (reading, URL, attempt, job) → queue.send. A failed send rolls the reading back to failed (or its prior ready state) and returns 503.",
    cites: ["src/intake/activation.ts", "src/intake/index.ts", "src/attempt-ownership.ts"],
    payload: `AttemptActivation {\n  manifest (pending),\n  queueMessage: ProcessReadingArgs,\n  artifacts? (import paths)\n}`,
  },
  {
    id: "queue",
    name: "READING_JOBS",
    gx: 9,
    gy: 3,
    w: 92,
    h: 48,
    depth: 44,
    zone: "queue",
    variant: "depot",
    blurb:
      "Cloudflare Queue producer/consumer. Production: max_concurrency=3, max_retries=3, dead_letter_queue=reading-lite-dlq. Local wrangler dev has no Queue (submit → 503).",
    cites: ["wrangler.toml", "src/index.ts"],
    payload: `ProcessReadingArgs {\n  id, url, urlHash, keyPrefix,\n  attemptId, trigger, email?,\n  source?, preserveReadyManifest?\n}`,
  },
  {
    id: "pipeline",
    name: "processReading",
    gx: 11,
    gy: 5,
    w: 74,
    h: 120,
    depth: 58,
    zone: "pipeline",
    variant: "mill",
    blurb:
      "Queue consumer pipeline: extract → write raw/extracted to R2 → embed source → pgvector similarity query → summarize (OpenAI or Anthropic, no silent fallback) → embed TL;DR → publish in one PostgreSQL transaction → optional Resend email.",
    cites: ["src/process-reading.ts", "src/attempt-io.ts", "src/modules/summarizer", "src/schemas/manifest.ts"],
    payload: `stages: queued → fetch_source →\nprepare_markdown → write_raw →\nwrite_extracted → embed_source →\nquery_similar → summarize →\nembed_summary → write_manifest →\nsend_email`,
  },
  {
    id: "extractor",
    name: "Extractor works",
    gx: 13,
    gy: 7,
    w: 60,
    h: 70,
    depth: 48,
    zone: "pipeline",
    variant: "shed",
    blurb:
      "Fetch source (timeout + size cap), linkedom + Readability + Turndown → markdown. Special cases: YouTube oEmbed floor; Reddit throws RedditManualImportError (manual import skill).",
    cites: [
      "src/modules/extractor",
      "src/modules/extractor/youtube.ts",
      "src/modules/http-retry",
    ],
    payload: `ExtractedContent {\n  title?, markdown?, raw,\n  content_type, content_status,\n  content_bytes, content_sha256\n}`,
  },
  {
    id: "r2",
    name: "R2 warehouse",
    gx: 7,
    gy: 8,
    w: 96,
    h: 100,
    depth: 70,
    zone: "store",
    variant: "warehouse",
    blurb:
      "ContentStore over R2: captured content only. Each attempt writes raw and extracted objects under its own revisions/{attemptId}/ prefix, written before the row that points at them commits. Keys stay relative, spelled by r2KeyLayout. The hosted refresh cursor also lives here.",
    cites: [
      "src/modules/stores/content-store.ts",
      "src/modules/stores/layout.ts",
    ],
    payload: `u/{tenantId}/{key_prefix}/revisions/{attemptId}/raw.*\nu/{tenantId}/{key_prefix}/revisions/{attemptId}/extracted.md\nu/{tenantId}/index/refresh-cursor.json`,
  },
  {
    id: "publish-gate",
    name: "Publish gate",
    gx: 9,
    gy: 7,
    w: 58,
    h: 64,
    depth: 46,
    zone: "control",
    variant: "bridge",
    blurb:
      "PgReadingWriter locks the reading row and decides ownership under the lock. Publication is one transaction in a fixed order: lock, attempt ownership, URL ownership, revision, reading, relationships, embedding, attempt. A failed publish rolls back and requeues; a missing row is the deletion fence.",
    cites: ["src/modules/stores/postgres/reading-writer.ts", "src/attempt-io.ts", "src/attempt-ownership.ts"],
    payload: `publish(args, manifest, {\n  keyPrefix, content, embedding\n}) → { committed, published }`,
  },
  {
    id: "postgres",
    name: "PostgreSQL vault",
    gx: 11,
    gy: 9,
    w: 68,
    h: 88,
    depth: 52,
    zone: "index",
    variant: "lattice",
    blurb:
      "PostgreSQL (Neon via Hyperdrive) holds reading state and the control plane; every query is scoped by tenant_id. Similarity is an exact pgvector cosine scan over 1536-dimensional TL;DR embeddings in reading_embeddings (no HNSW index).",
    cites: [
      "src/modules/stores/postgres/reading-store.ts",
      "src/modules/stores/postgres/similarity-store.ts",
      "db/migrations/",
    ],
    payload: `readings · reading_urls · reading_revisions\nreading_attempts · reading_jobs\nreading_relationships\nreading_embeddings vector(1536)`,
  },
  {
    id: "openai",
    name: "OpenAI tower",
    gx: 15,
    gy: 4,
    w: 56,
    h: 104,
    depth: 44,
    zone: "external",
    variant: "tower",
    blurb:
      "Always required for embeddings. Default summarizer: Responses structured output with gpt-5.6-terra and high effort in staging/production. Fail-closed provider selection.",
    cites: [
      "src/modules/openai-summarizer",
      "src/modules/embeddings",
      "src/modules/summarizer",
    ],
    payload: `embed: text-embedding-3-small\nsummarize: Responses JSON schema\nusage → manifest.usage`,
  },
  {
    id: "anthropic",
    name: "Anthropic annex",
    gx: 15,
    gy: 6,
    w: 52,
    h: 72,
    depth: 42,
    zone: "external",
    variant: "annex",
    blurb:
      "Optional summarizer when SUMMARIZER_PROVIDER=anthropic. tool_choice any (emit_reading or reject_source); system+tools cached via cache_control. No silent fallback to OpenAI.",
    cites: ["src/modules/anthropic", "src/modules/summarizer"],
    payload: `messages.create +\ntool_choice: any\nANTHROPIC_API_KEY required`,
  },
  {
    id: "dlq",
    name: "DLQ bunker",
    gx: 11,
    gy: 2,
    w: 64,
    h: 54,
    depth: 46,
    zone: "queue",
    variant: "bunker",
    blurb:
      "Exhausted main-queue retries land on reading-lite-dlq. markDeadLettered converts a stranded pending reading to retryable failed and acks terminally (never retry DLQ).",
    cites: ["src/index.ts", "src/process-reading.ts", "wrangler.toml"],
    payload: `handleDeadLetter →\nmarkDeadLettered(args) →\nstatus: "failed" + ack`,
  },
  {
    id: "resend",
    name: "Resend post",
    gx: 13,
    gy: 10,
    w: 54,
    h: 60,
    depth: 44,
    zone: "external",
    variant: "post",
    blurb:
      "Optional per-reading email after successful publish. Failure here logs a send_email attempt event but does not flip the ready reading to failed.",
    cites: ["src/modules/email.ts", "src/process-reading.ts"],
    payload: `sendReadingEmail({\n  title, tldr, WEB_BASE_URL link\n})`,
  },
  {
    id: "staleness",
    name: "Staleness overlay",
    gx: 5,
    gy: 8,
    w: 50,
    h: 52,
    depth: 40,
    zone: "control",
    variant: "kiosk",
    blurb:
      "Read-time annotation only: running attempt or pending past PENDING_TTL_SECONDS surfaces as failed without a write. Single-homed applyStaleness serves router read paths and Reading intake.",
    cites: ["src/modules/staleness.ts", "src/router.ts"],
    payload: `stalenessOf(record, now, ttl)\n→ surface status "failed"`,
  },
];

/**
 * Flows trace real control/data paths. Hops cite the seam that carries the payload.
 * @type {Record<string, {
 *   title: string,
 *   summary: string,
 *   cites: string[],
 *   kind: "control"|"data"|"fail"|"read",
 *   nodes: string[],
 *   hops: Array<{ from: string, to: string, label: string, payload: string }>
 * }>}
 */
const FLOWS = {
  submit: {
    title: "1 · Submit & claim",
    summary:
      "The frontend POSTs a URL. Reading intake resolves ownership against reading_urls. An unclaimed URL is claimed in one transaction with the pending reading, its attempt, and its job; activateAttempt then enqueues ProcessReadingArgs. Ready/pending owners return existing; failed owners reprocess in place.",
    cites: [
      "app/src/api/save.ts",
      "src/router.ts",
      "src/intake/index.ts",
      "src/intake/activation.ts",
      "src/modules/stores/postgres/reading-writer.ts",
    ],
    kind: "control",
    nodes: ["spa", "worker", "claim", "postgres", "activate", "queue"],
    hops: [
      {
        from: "spa",
        to: "worker",
        label: "POST /api/readings",
        payload: `{ "url": "https://…", "email": true }`,
      },
      {
        from: "worker",
        to: "claim",
        label: "resolve owner(url)",
        payload: `reading_urls (tenant_id, url)`,
      },
      {
        from: "claim",
        to: "postgres",
        label: "claimUrl",
        payload: `one transaction:\npending reading · reading_urls row\nattempt · job`,
      },
      {
        from: "claim",
        to: "activate",
        label: "claimed → activate",
        payload: `AttemptActivation`,
      },
      {
        from: "activate",
        to: "queue",
        label: "queue.send",
        payload: `ProcessReadingArgs`,
      },
    ],
  },
  process: {
    title: "2 · Process pipeline",
    summary:
      "Queue consumer runs processReading: extract source (or use import markdown), persist raw/extracted to R2 under the attempt's revision prefix, embed for similarity, query pgvector, summarize once through the selected provider, embed the TL;DR for the stored embedding.",
    cites: [
      "src/index.ts",
      "src/process-reading.ts",
      "src/modules/extractor",
      "src/modules/embeddings",
      "src/modules/summarizer",
    ],
    kind: "data",
    nodes: ["queue", "pipeline", "extractor", "r2", "openai", "anthropic", "postgres"],
    hops: [
      {
        from: "queue",
        to: "pipeline",
        label: "dispatchQueueMessage",
        payload: `Message<ProcessReadingArgs>`,
      },
      {
        from: "pipeline",
        to: "extractor",
        label: "extractSource",
        payload: `fetch URL | markdown source`,
      },
      {
        from: "extractor",
        to: "r2",
        label: "write_raw / write_extracted",
        payload: `revisions/{attemptId}/\nraw.* + extracted.md`,
      },
      {
        from: "pipeline",
        to: "openai",
        label: "embed_source",
        payload: `text-embedding-3-small\n1536-dim query vector`,
      },
      {
        from: "openai",
        to: "postgres",
        label: "query_similar",
        payload: `exact pgvector top-K\nSimilarContext[]`,
      },
      {
        from: "pipeline",
        to: "openai",
        label: "summarize (default)",
        payload: `structured reading +\nconnections + novelty`,
      },
      {
        from: "pipeline",
        to: "anthropic",
        label: "summarize (optional)",
        payload: `emit_reading or reject_source\nwhen provider=anthropic`,
      },
      {
        from: "pipeline",
        to: "openai",
        label: "embed_summary",
        payload: `embed(tldr) → embedding`,
      },
    ],
  },
  publish: {
    title: "3 · Terminal publish",
    summary:
      "publishReady commits the terminal reading in one PostgreSQL transaction: attempt ownership, URL ownership, revision, reading, relationships, and embedding together. A failed commit rolls back and requeues rather than marking the reading failed. Eligible Resend mail follows a searchable publish.",
    cites: [
      "src/process-reading.ts",
      "src/attempt-io.ts",
      "src/modules/stores/postgres/reading-writer.ts",
      "src/modules/email.ts",
    ],
    kind: "data",
    nodes: ["pipeline", "publish-gate", "postgres", "resend"],
    hops: [
      {
        from: "pipeline",
        to: "publish-gate",
        label: "write_manifest",
        payload: `publishReady(manifest,\n  tldr_embedding)`,
      },
      {
        from: "publish-gate",
        to: "postgres",
        label: "one transaction",
        payload: `lock → attempt → URL →\nrevision → reading →\nrelationships → embedding`,
      },
      {
        from: "pipeline",
        to: "resend",
        label: "send_email",
        payload: `notification (non-fatal)`,
      },
    ],
  },
  failure: {
    title: "4 · Retry & DLQ",
    summary:
      "Upstream 429 becomes RateLimitedError → queue retry with delay; the reading stays pending. Exhausted retries route to DLQ; markDeadLettered writes retryable failed. Lease/budget denial defers the attempt; a failed publish commit retries. Other processing errors write failed, preserving a prior ready reading on reprocess.",
    cites: [
      "src/index.ts",
      "src/modules/http-retry",
      "src/process-reading.ts",
      "src/modules/staleness.ts",
    ],
    kind: "fail",
    nodes: ["pipeline", "queue", "dlq", "postgres", "staleness", "worker"],
    hops: [
      {
        from: "pipeline",
        to: "queue",
        label: "RateLimitedError",
        payload: `msg.retry({ delaySeconds })\nreading stays pending`,
      },
      {
        from: "queue",
        to: "dlq",
        label: "max_retries exhausted",
        payload: `dead_letter_queue\nreading-lite-dlq`,
      },
      {
        from: "dlq",
        to: "postgres",
        label: "markDeadLettered",
        payload: `status: "failed"\nretryable strand`,
      },
      {
        from: "staleness",
        to: "worker",
        label: "read-time annotate",
        payload: `pending past TTL →\nsurface as failed`,
      },
    ],
  },
  read: {
    title: "5 · Read path",
    summary:
      "Authenticated list/detail/content/diagnostics. List and q/tag search query the tenant's reading rows in PostgreSQL; detail reads the reading row; content streams from R2; the staleness overlay may annotate pending as failed without writing. Lookup is side-effect-free.",
    cites: [
      "app/src/api/library.ts",
      "src/router.ts",
      "src/modules/stores/postgres/reading-store.ts",
      "src/modules/stores/content-store.ts",
      "src/modules/staleness.ts",
    ],
    kind: "read",
    // Frontend list/search is q/tag over PostgreSQL rows via the Worker — it never
    // calls POST /api/readings/similar, so the pgvector scan stays off this path.
    nodes: ["spa", "worker", "postgres", "r2", "staleness"],
    hops: [
      {
        from: "spa",
        to: "worker",
        label: "GET /api/readings*",
        payload: `Session cookie\nlist | detail | content`,
      },
      {
        from: "worker",
        to: "postgres",
        label: "list / detail",
        payload: `readings WHERE tenant_id = $1\n(q, tag, offset, limit)`,
      },
      {
        from: "worker",
        to: "r2",
        label: "content",
        payload: `revisions/{attemptId}/\nextracted.md | raw.*`,
      },
      {
        from: "worker",
        to: "staleness",
        label: "applyStaleness",
        payload: `read-time only`,
      },
    ],
  },
};

const OVERVIEW = {
  title: "reading-lite edge district",
  body:
    "A personal reading service on Cloudflare Workers with a TanStack Start frontend. Submit a URL → eager URL claim (pending reading, attempt, and job in one PostgreSQL transaction) → queue → extract to R2, embed, similar-context summarize → one PostgreSQL publish transaction with the embedding. Provider selection never falls back silently.",
  cites: ["docs/architecture.md", "src/index.ts", "src/router.ts", "src/process-reading.ts", "wrangler.toml"],
};

const buildingLayer = document.getElementById("building-layer");
const pathLayer = document.getElementById("path-layer");
const payloadLayer = document.getElementById("payload-layer");
const explainerTitle = document.getElementById("explainer-title");
const explainerBody = document.getElementById("explainer-body");
const explainerCites = document.getElementById("explainer-cites");
const payloadBox = document.getElementById("payload-box");
const payloadCode = document.getElementById("payload-code");
const mapViewport = document.getElementById("map-viewport");
const isoWorld = document.getElementById("iso-world");

let activeFlow = "submit";
let selectedId = null;

function buildingScreen(b) {
  // Anchor at the visual "front corner" of the footprint.
  return isoToScreen(b.gx, b.gy, 0);
}

function renderBuildings() {
  buildingLayer.innerHTML = "";
  for (const b of BUILDINGS) {
    const { x, y } = buildingScreen(b);
    const el = document.createElement("button");
    el.type = "button";
    el.className = "building";
    el.dataset.id = b.id;
    el.dataset.zone = b.zone;
    el.style.setProperty("--bw", `${b.w}px`);
    el.style.setProperty("--bh", `${b.h}px`);
    el.style.setProperty("--bd", `${Math.round(b.depth * 0.55)}px`);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.setAttribute("aria-label", b.name);
    const cols = b.w > 80 ? 4 : b.w > 60 ? 3 : 2;
    el.innerHTML = `
      <span class="label">${escapeHtml(b.name)}</span>
      <div class="iso">
        <div class="top"><span class="roof-mark"></span></div>
        <div class="left">
          <div class="windows" style="--cols:${cols}">${windows(cols * 3)}</div>
          ${roofExtra(b)}
        </div>
        <div class="right">
          <div class="windows" style="--cols:${Math.max(1, cols - 1)}">${windows(Math.max(1, cols - 1) * 2)}</div>
        </div>
      </div>
    `;
    el.addEventListener("click", () => selectBuilding(b.id));
    el.addEventListener("mouseenter", () => highlightBuilding(b.id));
    buildingLayer.appendChild(el);
  }
}

function roofExtra(b) {
  if (b.variant === "tower" || b.variant === "lattice") {
    return `<span class="antenna" aria-hidden="true"></span>`;
  }
  if (b.variant === "mill" || b.variant === "warehouse") {
    return `<span class="chimney" aria-hidden="true"></span>`;
  }
  return "";
}

function windows(n) {
  return Array.from({ length: n }, () => "<i></i>").join("");
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pathD(fromId, toId) {
  const a = BUILDINGS.find((b) => b.id === fromId);
  const b = BUILDINGS.find((b) => b.id === toId);
  const p0 = buildingScreen(a);
  const p1 = buildingScreen(b);
  // Lift endpoints to mid-height of each building for readable arcs.
  const y0 = p0.y - a.h * 0.45;
  const y1 = p1.y - b.h * 0.45;
  const mx = (p0.x + p1.x) / 2;
  const my = Math.min(y0, y1) - 36;
  return `M ${p0.x} ${y0} Q ${mx} ${my} ${p1.x} ${y1}`;
}

function renderPaths() {
  const flow = FLOWS[activeFlow];
  pathLayer.innerHTML = "";
  payloadLayer.innerHTML = "";
  flow.hops.forEach((hop, i) => {
    const d = pathD(hop.from, hop.to);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `trace ${flow.kind} is-on`);
    path.dataset.hop = String(i);
    pathLayer.appendChild(path);

    const packet = document.createElement("div");
    packet.className = `packet ${flow.kind} is-flying`;
    packet.style.offsetPath = `path('${d}')`;
    packet.style.setProperty("--dur", `${2.8 + i * 0.35}s`);
    packet.style.animationDelay = `${i * 0.28}s`;
    packet.title = hop.label;
    payloadLayer.appendChild(packet);
  });
}

function setFlow(id) {
  activeFlow = id;
  selectedId = null;
  document.querySelectorAll(".flow-btn").forEach((btn) => {
    const on = btn.dataset.flow === id;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  const flow = FLOWS[id];
  setExplainer(flow.title, flow.summary, flow.cites, flow.hops[0]?.payload ?? null, "Active flow");
  renderPaths();
  syncBuildingHighlight(flow.nodes);
}

function selectBuilding(id) {
  selectedId = id;
  const b = BUILDINGS.find((x) => x.id === id);
  setExplainer(b.name, b.blurb, b.cites, b.payload ?? null, "Building");
  const flowNodes = FLOWS[activeFlow].nodes;
  syncBuildingHighlight(flowNodes, id);
}

function highlightBuilding(id) {
  if (selectedId) return;
  const b = BUILDINGS.find((x) => x.id === id);
  setExplainer(b.name, b.blurb, b.cites, b.payload ?? null, "Building");
}

function showHop(hop) {
  setExplainer(hop.label, FLOWS[activeFlow].summary, FLOWS[activeFlow].cites, hop.payload, "Path hop");
}

function setExplainer(title, body, cites, payload, kicker = "District overview") {
  document.querySelector(".explainer-kicker").textContent = kicker;
  explainerTitle.textContent = title;
  explainerBody.textContent = body;
  explainerCites.innerHTML = cites.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join("");
  if (payload) {
    payloadBox.hidden = false;
    payloadCode.textContent = payload;
  } else {
    payloadBox.hidden = true;
    payloadCode.textContent = "";
  }
}

function syncBuildingHighlight(activeNodes, focusId = null) {
  const set = new Set(activeNodes);
  document.querySelectorAll(".building").forEach((el) => {
    const id = el.dataset.id;
    const onPath = set.has(id);
    el.classList.toggle("is-dim", !onPath);
    el.classList.toggle("is-hot", focusId ? id === focusId : onPath);
  });
}

function resetOverview() {
  selectedId = null;
  setExplainer(OVERVIEW.title, OVERVIEW.body, OVERVIEW.cites, null, "District overview");
  syncBuildingHighlight(FLOWS[activeFlow].nodes);
}

document.querySelectorAll(".flow-btn").forEach((btn) => {
  btn.addEventListener("click", () => setFlow(btn.dataset.flow));
});

// Drag-to-pan the map a little for exploration on smaller screens.
let dragging = false;
let startX = 0;
let startY = 0;
let baseX = 0;
let baseY = 0;

mapViewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".building")) return;
  dragging = true;
  mapViewport.classList.add("is-dragging");
  startX = e.clientX;
  startY = e.clientY;
  mapViewport.setPointerCapture(e.pointerId);
});

function applyPan(x, y) {
  // Pan via CSS vars so media-query --map-scale is preserved (inline
  // transform would clobber the responsive scale on small viewports).
  isoWorld.style.setProperty("--pan-x", `${x}px`);
  isoWorld.style.setProperty("--pan-y", `${y}px`);
}

mapViewport.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  applyPan(baseX + dx, baseY + dy);
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  mapViewport.classList.remove("is-dragging");
  baseX += e.clientX - startX;
  baseY += e.clientY - startY;
  applyPan(baseX, baseY);
}

mapViewport.addEventListener("pointerup", endDrag);
mapViewport.addEventListener("pointercancel", endDrag);

mapViewport.addEventListener("dblclick", () => {
  baseX = 0;
  baseY = 0;
  applyPan(0, 0);
  resetOverview();
});

renderBuildings();
setFlow("submit");
