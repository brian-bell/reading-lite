/**
 * reading-lite isometric system map
 * Building placement and flows are derived from the Worker/SPA architecture
 * described in README.md and the modules cited on each node.
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
    name: "Pages SPA",
    gx: 1,
    gy: 8,
    w: 70,
    h: 58,
    depth: 52,
    zone: "client",
    variant: "pavilion",
    blurb:
      "React/Vite SPA on Cloudflare Pages. Stores the bearer token in localStorage, lists/searches readings, submits URLs, opens content blobs, and can start reprocesses. Invalidates queries after submit/reprocess (no continuous pending poll).",
    cites: ["web/src/App.tsx", "web/src/api.ts", "web/src/types.ts"],
    payload: `{ Authorization: "Bearer …" }\nGET /api/readings?q=&tag=\nPOST /api/readings { url, email? }`,
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
      "fetch handler mounts the Hono app; queue handler branches main READING_JOBS vs DLQ. RateLimitedError → msg.retry({ delaySeconds }); other process errors ack after failed-manifest write.",
    cites: ["src/index.ts", "src/router.ts", "wrangler.toml"],
    payload: `Env bindings:\nREADINGS_BUCKET · READINGS_INDEX\nREADING_JOBS? · secrets/vars`,
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
      "URL ownership via index/by-url/{sha256(url)}. Outcomes: owned | initializing | unclaimed. Submit/import claim eagerly; lookup stays side-effect-free (no cold legacy claim, no damage repair).",
    cites: ["src/modules/reading-claim.ts", "src/router.ts"],
    payload: `OwnerResolution\n→ owned { pointer, manifest }\n→ initializing { pointer }\n→ unclaimed { replaceEtag? }`,
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
      "Canonical eager write-and-enqueue: optional artifacts → pending manifest → by-id pointer → list index row → queue.send. Throw before send rolls back to failed (503).",
    cites: ["src/attempt-activation.ts", "src/attempt-ownership.ts"],
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
      "Cloudflare Queue producer/consumer. Production: max_concurrency=3, max_retries=3, dead_letter_queue=reading-lite-dlq. Local wrangler.dev intentionally omits the binding (submit → 503).",
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
      "Queue consumer pipeline: extract → write raw/extracted → embed source → Vectorize.query → summarize (OpenAI or Anthropic, no silent fallback) → embed TL;DR → commitTerminalManifest → optional Resend email.",
    cites: ["src/process-reading.ts", "src/modules/summarizer", "src/schemas/manifest.ts"],
    payload: `stages: queued → fetch_source →\nprepare_markdown → write_raw →\nwrite_extracted → embed_source →\nquery_similar → summarize →\nembed_summary → write_manifest →\nwrite_indexes → upsert_vector →\nsend_email`,
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
      "ReadingStore codecs over R2: manifests, raw/extracted, by-id + by-url pointers, attempts, diagnostics. ListIndexStore owns index/list.json CAS mutate loop (jittered backoff) and q/tag filter.",
    cites: [
      "src/modules/stores/reading-store.ts",
      "src/modules/stores/list-index.ts",
    ],
    payload: `readings/{id}/manifest.json\nreadings/{id}/extracted.md\nreadings/{id}/raw.*\nindex/by-url/{sha256}\nindex/by-id/{id}\nindex/list.json`,
  },
  {
    id: "visibility",
    name: "Visibility bridge",
    gx: 9,
    gy: 7,
    w: 58,
    h: 64,
    depth: 46,
    zone: "control",
    variant: "bridge",
    blurb:
      "List-row + Vectorize vector lockstep behind attemptOwnership. publish / remove / restoreIfOwner. Success publishes both; failure paths are list-only when similarity is null.",
    cites: ["src/reading-visibility.ts", "src/attempt-ownership.ts"],
    payload: `publish(manifest, vector?)\nremove(args)  // list±vector\nrestoreIfOwner(args)`,
  },
  {
    id: "vectorize",
    name: "Vectorize lattice",
    gx: 11,
    gy: 9,
    w: 68,
    h: 88,
    depth: 52,
    zone: "index",
    variant: "lattice",
    blurb:
      "SimilarityStore over Vectorize: query top-K for summarizer context; upsert TL;DR embedding (1536-dim text-embedding-3-small) with url/title/tags metadata.",
    cites: ["src/modules/stores/similarity-store.ts", "src/modules/embeddings"],
    payload: `query(embedding, k=5)\nupsert(id, tldr_embedding, meta)\ndelete(id)`,
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
      "Always required for embeddings. Default summarizer: Responses structured output (gpt-5.6-terra; prod reasoning medium). Fail-closed provider selection.",
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
      "Exhausted main-queue retries land on reading-lite-dlq. markDeadLettered converts stranded pending to retryable failed and acks terminally (never retry DLQ).",
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
      "Optional per-reading email after successful publish. Failure here logs send_email attempt event but does not flip the ready manifest to failed.",
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
      "Read-time annotation only: running attempt or pending past PENDING_TTL_SECONDS surfaces as failed without a write. Router adapters annotateStale / annotateStaleIndexItem.",
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
      "SPA POSTs a URL. Router resolves ownership (ReadingClaim). Unclaimed URLs get an eager by-url pointer, then activateAttempt writes pending state and enqueues ProcessReadingArgs. Ready/pending owners return existing; failed owners reprocess in place.",
    cites: [
      "web/src/api.ts",
      "src/router.ts",
      "src/modules/reading-claim.ts",
      "src/attempt-activation.ts",
    ],
    kind: "control",
    nodes: ["spa", "worker", "claim", "activate", "r2", "queue"],
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
        label: "resolveOwner(url)",
        payload: `sha256(url) → index/by-url/…`,
      },
      {
        from: "claim",
        to: "activate",
        label: "unclaimed → activate",
        payload: `claim by-url slot\nthen AttemptActivation`,
      },
      {
        from: "activate",
        to: "r2",
        label: "eager writes",
        payload: `manifest pending\nby-id pointer\nlist.json row`,
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
      "Queue consumer runs processReading: extract source (or use import markdown), persist raw/extracted, embed for similarity, query Vectorize, summarize once through the selected provider, embed the TL;DR for the durable vector.",
    cites: [
      "src/index.ts",
      "src/process-reading.ts",
      "src/modules/extractor",
      "src/modules/embeddings",
      "src/modules/summarizer",
    ],
    kind: "data",
    nodes: ["queue", "pipeline", "extractor", "r2", "openai", "anthropic", "vectorize"],
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
        payload: `raw.* + extracted.md`,
      },
      {
        from: "pipeline",
        to: "openai",
        label: "embed_source",
        payload: `text-embedding-3-small\n1536-dim query vector`,
      },
      {
        from: "openai",
        to: "vectorize",
        label: "query_similar",
        payload: `top-K SimilarContext[]`,
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
        payload: `embed(tldr) → vector`,
      },
    ],
  },
  publish: {
    title: "3 · Terminal publish",
    summary:
      "commitTerminalManifest decides publish vs remove vs restore. ReadingVisibility keeps list.json and the Vectorize vector in lockstep on success; then optional Resend notification.",
    cites: [
      "src/process-reading.ts",
      "src/reading-visibility.ts",
      "src/modules/stores/list-index.ts",
      "src/modules/email.ts",
    ],
    kind: "data",
    nodes: ["pipeline", "visibility", "r2", "vectorize", "resend"],
    hops: [
      {
        from: "pipeline",
        to: "visibility",
        label: "commitTerminalManifest",
        payload: `Manifest status: ready\n+ PublishVector`,
      },
      {
        from: "visibility",
        to: "r2",
        label: "write_indexes",
        payload: `appendOrReplaceListIndexItem`,
      },
      {
        from: "visibility",
        to: "vectorize",
        label: "upsert_vector",
        payload: `{ id, tldr_embedding, meta }`,
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
      "Upstream 429 becomes RateLimitedError → queue retry with delay; manifest stays pending. Exhausted retries route to DLQ; markDeadLettered writes retryable failed. Non-rate-limit errors write failed and ack.",
    cites: [
      "src/index.ts",
      "src/modules/http-retry",
      "src/process-reading.ts",
      "src/modules/staleness.ts",
    ],
    kind: "fail",
    nodes: ["pipeline", "queue", "dlq", "r2", "staleness", "worker"],
    hops: [
      {
        from: "pipeline",
        to: "queue",
        label: "RateLimitedError",
        payload: `msg.retry({ delaySeconds })\nmanifest stays pending`,
      },
      {
        from: "queue",
        to: "dlq",
        label: "max_retries exhausted",
        payload: `dead_letter_queue\nreading-lite-dlq`,
      },
      {
        from: "dlq",
        to: "r2",
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
      "Authenticated list/detail/content/diagnostics. List reads index/list.json with q/tag filter; detail reads the manifest; staleness overlay may annotate pending as failed without writing. Lookup is side-effect-free.",
    cites: [
      "web/src/App.tsx",
      "src/router.ts",
      "src/modules/stores/list-index.ts",
      "src/modules/staleness.ts",
    ],
    kind: "read",
    // SPA list/search is q/tag over index/list.json via the Worker — it never
    // calls POST /api/readings/similar, so Vectorize stays off this path.
    nodes: ["spa", "worker", "r2", "staleness"],
    hops: [
      {
        from: "spa",
        to: "worker",
        label: "GET /api/readings*",
        payload: `Bearer token\nlist | detail | content`,
      },
      {
        from: "worker",
        to: "r2",
        label: "list / manifest / blobs",
        payload: `index/list.json\nreadings/…/manifest.json`,
      },
      {
        from: "worker",
        to: "staleness",
        label: "annotateStale",
        payload: `read-time only`,
      },
    ],
  },
};

const OVERVIEW = {
  title: "reading-lite edge district",
  body:
    "A personal reading service on Cloudflare Workers plus a React SPA. Submit a URL → eager by-url claim → pending manifest → queue → extract, embed, similar-context summarize → terminal R2 + Vectorize write. Provider selection never falls back silently.",
  cites: ["README.md", "src/index.ts", "src/router.ts", "src/process-reading.ts", "wrangler.toml"],
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
