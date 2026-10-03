/**
 * The study's pure logic: hash routes, filters, and what the prototype derives
 * from the shared fixtures (threads, tension pairs, the catalog, simulated
 * meaning search, the desk, the digest preview). No DOM, no network; App.tsx
 * holds the state and the screens render these results.
 */
import { REMOVED_TARGET_ID, STUDY_NOW, dateOn, hostOf, readings as authored, type Reading, type ReadingError, type TensionKind } from "./samples";

export type View =
  | "desk"
  | "library"
  | "reading"
  | "threads"
  | "thread"
  | "catalog"
  | "save"
  | "provider"
  | "digest"
  | "landing";

const VIEWS: View[] = ["desk", "library", "reading", "threads", "thread", "catalog", "save", "provider", "digest", "landing"];

/** The desk is home. */
export const HOME_VIEW: View = "desk";

export type Route = {
  view: View;
  id: string;
  trail: string[];
  /** Library and catalog: the search text; library: the active tag; catalog: the facet. */
  q: string;
  tag: string;
  facet: string;
  /** Catalog: "text" or "meaning". */
  mode: string;
};

/** The three-direction study's hashes carried a direction first; those links still open. */
const LEGACY_PREFIXES = ["threads", "desk", "catalog"];

export function parseRoute(hash: string): Route {
  const [path, search = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (LEGACY_PREFIXES.includes(parts[0]) && (VIEWS.includes(parts[1] as View) || ["tensions", "review", "find", "inbox"].includes(parts[1]))) parts.shift();
  const head = parts[0] === "tensions" ? "threads" : parts[0] === "find" ? "catalog" : parts[0] === "inbox" ? "desk" : parts[0];
  const view = VIEWS.includes(head as View) ? (head as View) : HOME_VIEW;
  const params = new URLSearchParams(search);
  return {
    view,
    id: parts[1] ? decodeURIComponent(parts[1]) : "",
    trail: (params.get("from") || "").split(",").filter(Boolean),
    q: params.get("q") || "",
    tag: params.get("tag") || "",
    facet: params.get("facet") || "",
    mode: params.get("mode") || "",
  };
}

const VIEWS_WITH_ID: View[] = ["reading", "thread", "catalog"];

export function routeHash(route: Route): string {
  const path = `#/${route.view}${VIEWS_WITH_ID.includes(route.view) && route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
  const params = new URLSearchParams();
  if (route.trail.length) params.set("from", route.trail.join(","));
  if (route.q) params.set("q", route.q);
  if (route.tag) params.set("tag", route.tag);
  if (route.facet) params.set("facet", route.facet);
  if (route.mode) params.set("mode", route.mode);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export function emptyRoute(view: View, id = ""): Route {
  return { view, id, trail: [], q: "", tag: "", facet: "", mode: "" };
}

/** The six bundled samples (app/src/samples): readable before sign-in, with a banner. */
export const SAMPLE_IDS = ["a-quieter-internet", "the-case-for-a-little-friction", "libraries-are-gardens", "the-tab-that-never-closes", "slow-reading-week", "against-the-endless-queue"];

// ---- Library ---------------------------------------------------------------

export type Filters = { q: string; tag: string };

export function matchesText(reading: Reading, q: string): boolean {
  const query = q.trim().toLocaleLowerCase();
  if (!query) return true;
  return [reading.title, reading.tldr ?? "", ...(reading.summary ?? []), ...reading.tags, hostOf(reading.url)]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function filterReadings(items: Reading[], filters: Filters): Reading[] {
  return items.filter((r) => (!filters.tag || r.tags.includes(filters.tag)) && matchesText(r, filters.q));
}

export function newestFirst(items: Reading[]): Reading[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function allTags(items: Reading[]): string[] {
  return [...new Set(items.flatMap((r) => r.tags))].sort();
}

// ---- Relationships ---------------------------------------------------------

export const TENSION_LABELS: Record<TensionKind, string> = {
  contradicts: "Contradicts",
  supersedes: "Supersedes",
  superseded_by: "Superseded by",
  qualifies: "Qualifies",
  qualified_by: "Qualified by",
};

export type Target = { id: string; title: string; status: Reading["status"] } | undefined;

export function targetOf(items: Reading[], id: string): Target {
  const r = items.find((item) => item.id === id);
  return r ? { id: r.id, title: r.title, status: r.status } : undefined;
}

/** Both directions of every tension, deduplicated to one row per pair, as a library-wide list. */
export type TensionPair = { a: Reading; b: Reading; kind: TensionKind; reason: string };

export function tensionPairs(items: Reading[]): TensionPair[] {
  const seen = new Set<string>();
  const pairs: TensionPair[] = [];
  for (const a of items) {
    for (const t of a.tensions) {
      const b = items.find((r) => r.id === t.id);
      if (!b) continue;
      const key = [a.id, b.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      // Read the pair from the side whose kind is the active voice, so the row says "X contradicts Y".
      const passive = t.kind === "superseded_by" || t.kind === "qualified_by";
      pairs.push(passive
        ? { a: b, b: a, kind: t.kind === "superseded_by" ? "supersedes" : "qualifies", reason: t.reason }
        : { a, b, kind: t.kind, reason: t.reason });
    }
  }
  return pairs;
}

/**
 * Threads: the connected components of the connection and
 * tension graph over ready readings, oldest reading first inside each, named
 * by the tag the most readings in it share. A reading with no relationships
 * is not in a thread.
 */
export type Thread = { id: string; name: string; readings: Reading[]; tensions: number; updatedAt: string };

export function threadsOf(items: Reading[]): Thread[] {
  const ready = items.filter((r) => r.status === "ready");
  const parent = new Map<string, string>(ready.map((r) => [r.id, r.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    parent.set(find(a), find(b));
  };
  for (const r of ready) {
    for (const c of r.connections) union(r.id, c.id);
    for (const t of r.tensions) union(r.id, t.id);
  }
  const groups = new Map<string, Reading[]>();
  for (const r of ready) {
    const root = find(r.id);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  const threads: Thread[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const counts = new Map<string, number>();
    for (const r of ordered) for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const [tag] = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0] ?? ["thread"];
    const name = tag[0].toUpperCase() + tag.slice(1);
    const ids = new Set(ordered.map((r) => r.id));
    const tensions = tensionPairs(ordered.filter((r) => ids.has(r.id))).length;
    threads.push({
      id: ordered[0].id,
      name,
      readings: ordered,
      tensions,
      updatedAt: ordered[ordered.length - 1].createdAt,
    });
  }
  return threads.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function threadFor(threads: Thread[], readingId: string): Thread | undefined {
  return threads.find((t) => t.readings.some((r) => r.id === readingId));
}

/** An older connection worth revisiting is one saved more than 60 days before the reading. */
export function revisitPrompts(items: Reading[], reading: Reading): { target: Reading; reason: string }[] {
  const since = Date.parse(reading.createdAt) - 60 * 86_400_000;
  return reading.connections
    .map((c) => ({ target: items.find((r) => r.id === c.id), reason: c.reason }))
    .filter((p): p is { target: Reading; reason: string } => p.target !== undefined && Date.parse(p.target.createdAt) < since);
}

export function relationshipCount(reading: Reading): string | undefined {
  const parts = [counted(reading.connections.length, "connection"), counted(reading.tensions.length, "tension")].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function counted(n: number, noun: string): string | undefined {
  return n === 0 ? undefined : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export const REMOVED_ID = REMOVED_TARGET_ID;

// ---- Novelty and failures (the production copy) -----------------------------

export const NOVELTY: Record<NonNullable<Reading["novelty"]>, { label: string; sentence: string }> = {
  novel: { label: "Novel", sentence: "Nothing already in your library covers this closely." },
  familiar: { label: "Familiar", sentence: "Overlaps with readings already in your library." },
  duplicate: { label: "Duplicate", sentence: "Effectively the same piece as one already in your library." },
};
export const SPARSE_SENTENCE = "Your library had no close readings when this was processed.";

export function noveltyOf(reading: Reading): { label: string; sentence: string } | undefined {
  if (reading.status !== "ready" || !reading.novelty) return undefined;
  const verdict = NOVELTY[reading.novelty];
  return reading.similarityCount === 0 ? { label: verdict.label, sentence: SPARSE_SENTENCE } : verdict;
}

export type Outcome = "ready" | "source" | "key" | "billing" | "provider" | "hosting";

export const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "ready", label: "Ready" },
  { value: "source", label: "Source unreachable" },
  { value: "key", label: "Key invalid" },
  { value: "billing", label: "Out of credit" },
  { value: "provider", label: "Provider rate limit" },
  { value: "hosting", label: "Hosting limit" },
];

/** The failure a sample outcome writes, in the backend's own codes (app/src/reading-failure.ts categorises these). */
export const FAILURE_FOR: Record<Exclude<Outcome, "ready">, NonNullable<Reading["error"]>> = {
  source: { code: "BadStatusError", message: "The page returned 403.", stage: "fetch_source", httpStatus: 403 },
  key: { code: "provider_key_invalid", message: "OpenAI rejected the key.", stage: "summarize", httpStatus: 401 },
  billing: { code: "provider_insufficient_quota", message: "OpenAI reported insufficient quota.", stage: "summarize", httpStatus: 429 },
  provider: { code: "RateLimitedError", message: "OpenAI asked us to slow down.", stage: "summarize", httpStatus: 429 },
  hosting: { code: "SpendAdmissionError", message: "Today's processing allowance is used up.", stage: "summarize" },
};

// ---- Read-time state -------------------------------------------------------

/** The backend's PENDING_TTL_SECONDS: a pending reading older than this reads as failed. */
export const STALE_AFTER_MS = 15 * 60_000;

/**
 * The backend's stale annotation (src/modules/staleness.ts): a pending
 * reading whose attempt started more than the window ago is surfaced as
 * failed with `stale_pending`, without a write. The stored row stays pending,
 * so a retry starts a fresh attempt.
 */
export function annotateStale(reading: Reading, now = STUDY_NOW): Reading {
  if (reading.status !== "pending") return reading;
  const started = Date.parse(reading.attemptStartedAt ?? reading.createdAt);
  if (Date.parse(now) - started <= STALE_AFTER_MS) return reading;
  return {
    ...reading,
    status: "failed",
    error: { code: "stale_pending", message: "Processing stopped before finishing.", stage: reading.stage ?? "queued" },
  };
}

/** A ready reading whose last attempt was a reprocess that failed: its earlier summary and content stay. */
export function reprocessFailed(reading: Reading): boolean {
  return reading.status === "ready" && reading.lastAttempt?.trigger === "reprocess" && reading.lastAttempt.status === "failed";
}

/** The failure a card, badge, or desk row explains: the reading's own, or its failed reprocess's. */
export function failureOf(reading: Reading): ReadingError | undefined {
  if (reading.status === "failed") return reading.error;
  return reprocessFailed(reading) ? reading.lastAttempt?.error : undefined;
}

export type FailureCopy = { headline: string; detail?: string; next?: string; settings?: string; importCopy?: boolean };

/** The production categories' copy (app/src/reading-failure.ts, ReadingStatusCard.tsx), keyed by code and stage. */
export function failureCopy(error: ReadingError): FailureCopy {
  switch (error.code) {
    case "provider_key_required":
      return { headline: "No OpenAI key is connected.", next: "Connect your key, then retry.", settings: "Connect key" };
    case "provider_key_invalid":
      return { headline: "Your OpenAI key needs replacing.", next: "Replace your key, then retry.", settings: "Replace key" };
    case "provider_insufficient_quota":
      return { headline: "Your OpenAI account is out of credit.", next: "Add credit in OpenAI's billing settings, then retry.", settings: "Provider settings" };
    case "SpendAdmissionError":
      return { headline: "Reading Lite's processing limit was reached.", detail: error.message, next: "Retry once the limit resets." };
    case "RateLimitedError":
      return { headline: "The AI provider is rate limiting requests.", detail: error.message, next: "Wait a few minutes, then retry." };
    case "stale_pending":
    case "stale_active_attempt":
    case "QueueRetriesExhaustedError":
      return { headline: "Processing stopped before finishing." };
    default:
      if (error.stage === "fetch_source") return { headline: "The page couldn't be fetched.", detail: error.message, importCopy: true };
      return { headline: error.message };
  }
}

export function stageLabel(stage: string | undefined): "Fetching" | "Analyzing" | "Publishing" | "Processing" {
  if (!stage) return "Processing";
  if (["queued", "fetch_source", "prepare_markdown", "write_raw", "write_extracted"].includes(stage)) return "Fetching";
  if (["embed_source", "query_similar", "summarize", "embed_summary"].includes(stage)) return "Analyzing";
  if (["upsert_vector", "write_manifest", "write_indexes", "send_email"].includes(stage)) return "Publishing";
  return "Processing";
}

// ---- The catalog and Find --------------------------------------------------

export type CatalogKind = "people" | "orgs" | "keywords" | "hosts";

export const CATALOG_KINDS: { kind: CatalogKind; label: string; singular: string }[] = [
  { kind: "people", label: "People", singular: "person" },
  { kind: "orgs", label: "Organizations", singular: "organization" },
  { kind: "keywords", label: "Keywords", singular: "keyword" },
  { kind: "hosts", label: "Hosts", singular: "host" },
];

export function catalogTerms(reading: Reading, kind: CatalogKind): string[] {
  switch (kind) {
    case "people": return reading.people;
    case "orgs": return reading.orgs;
    case "keywords": return reading.keywords;
    case "hosts": return [hostOf(reading.url)];
  }
}

export type CatalogEntry = { term: string; count: number; readings: Reading[] };

export function catalogIndex(items: Reading[], kind: CatalogKind): CatalogEntry[] {
  const map = new Map<string, Reading[]>();
  for (const r of items.filter((item) => item.status === "ready")) {
    for (const term of catalogTerms(r, kind)) map.set(term, [...(map.get(term) ?? []), r]);
  }
  return [...map.entries()]
    .map(([term, matched]) => ({ term, count: matched.length, readings: newestFirst(matched) }))
    .sort((a, b) => a.term.localeCompare(b.term));
}

export function parseFacet(facet: string): { kind: CatalogKind; term: string } | undefined {
  const [kind, ...rest] = facet.split(":");
  const term = rest.join(":");
  return CATALOG_KINDS.some((k) => k.kind === kind) && term ? { kind: kind as CatalogKind, term } : undefined;
}

/**
 * Simulated meaning search: token overlap between the query and a reading's
 * title, lead, tags, and keywords, with the matched terms as the "why". In
 * production this is `POST /api/readings/similar` after embedding the query
 * with the reader's key; the overlap stands in for the cosine score here.
 */
export type MeaningHit = { reading: Reading; closeness: "close" | "near" | "faint"; why: string[] };

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "are", "with", "what", "why", "how", "about", "i", "my", "we"]);

function tokens(text: string): string[] {
  return text.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)).map(stem);
}

/** A light stem: one suffix off when enough of the word is left, then a trailing e, so save/saves/saved/saving agree. */
function stem(token: string): string {
  let t = token;
  for (const suffix of ["ing", "ies", "es", "ed", "s"]) {
    if (t.endsWith(suffix) && t.length - suffix.length >= 3) {
      t = suffix === "ies" ? `${t.slice(0, -3)}y` : t.slice(0, -suffix.length);
      break;
    }
  }
  return t.length > 3 && t.endsWith("e") ? t.slice(0, -1) : t;
}

export function meaningSearch(items: Reading[], q: string): MeaningHit[] {
  const query = new Set(tokens(q));
  if (query.size === 0) return [];
  const scored: { hit: MeaningHit; score: number }[] = [];
  for (const r of items.filter((item) => item.status === "ready")) {
    const fields = [r.title, r.tldr ?? "", ...(r.summary ?? []), ...r.tags, ...r.keywords];
    const own = new Set(fields.flatMap(tokens));
    const title = new Set(tokens(r.title));
    const matched = [...query].filter((t) => own.has(t));
    if (matched.length === 0) continue;
    const share = matched.length / query.size;
    // A term in the title counts twice, as an embedding of the title would weight it.
    const score = matched.length + matched.filter((t) => title.has(t)).length;
    const why = [...new Set([...r.keywords, ...r.tags].filter((term) => tokens(term).some((t) => query.has(t))))];
    scored.push({ hit: { reading: r, closeness: share >= 0.6 ? "close" : share >= 0.3 ? "near" : "faint", why }, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.hit.reading.title.localeCompare(b.hit.reading.title))
    .map(({ hit }) => hit);
}

// ---- Desk -----------------------------------------------------

export type Desk = {
  needsYou: Reading[];
  processing: Reading[];
  readySince: Reading[];
  onDesk: Reading[];
};

/** Items are read as the backend would serve them: a stale pending reading is already failed here. */
export function deskOf(items: Reading[], deskIds: string[], lastVisit: string): Desk {
  const since = Date.parse(lastVisit);
  return {
    needsYou: items.filter((r) => r.status === "failed" || reprocessFailed(r)),
    processing: items.filter((r) => r.status === "pending"),
    readySince: newestFirst(items.filter((r) => r.status === "ready" && Date.parse(r.createdAt) > since && !deskIds.includes(r.id))),
    onDesk: deskIds.map((id) => items.find((r) => r.id === id)).filter((r): r is Reading => r !== undefined),
  };
}

export type DigestPreview = {
  period: string;
  /** The Monday the digest goes out. */
  sendsOn: string;
  readings: Reading[];
  tensions: TensionPair[];
  inboxCount: number;
};

/** What the next weekly digest would say so far: the current week, Monday to Sunday, up to the study clock. */
export function digestPreview(items: Reading[], inboxCount: number, now = STUDY_NOW): DigestPreview {
  const current = new Date(now);
  const monday = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() - ((current.getUTCDay() + 6) % 7));
  const sunday = monday + 6 * 86_400_000;
  const recent = newestFirst(items.filter((r) => r.status === "ready" && Date.parse(r.createdAt) >= monday));
  const ids = new Set(recent.map((r) => r.id));
  const tensions = tensionPairs(items).filter((p) => ids.has(p.a.id) || ids.has(p.b.id));
  const sendsOn = new Date(sunday + 86_400_000);
  return {
    period: `${dateOn(new Date(monday).toISOString())} to ${dateOn(new Date(sunday).toISOString())}`,
    sendsOn: dateOn(sendsOn.toISOString()),
    readings: recent,
    tensions,
    inboxCount,
  };
}

export const DEFAULT_LAST_VISIT = "2026-09-27T20:00:00Z";

// ---- Scenarios --------------------------------------------------------------

export type Scenario = "full" | "new-reader" | "sparse" | "pending" | "stalled" | "failed" | "reprocess-failed" | "removed";

export const SCENARIOS: { value: Scenario; label: string }[] = [
  { value: "full", label: "Full library" },
  { value: "new-reader", label: "New reader, no key" },
  { value: "sparse", label: "Sparse archive" },
  { value: "pending", label: "Pending capture" },
  { value: "stalled", label: "Stalled capture" },
  { value: "failed", label: "Failed capture" },
  { value: "reprocess-failed", label: "Reprocess failed" },
  { value: "removed", label: "Removed connection" },
];

/** Where a scenario opens, when it opens on one reading. */
export const SCENARIO_READING: Partial<Record<Scenario, string>> = {
  pending: "why-we-skim",
  stalled: "the-cost-of-convenience",
  failed: "interface-budgets",
  "reprocess-failed": "reading-as-conversation",
  removed: "a-quieter-internet",
};

export function readingsForScenario(scenario: Scenario): Reading[] {
  if (scenario === "new-reader") return [];
  if (scenario === "sparse") return authored.filter((r) => r.id === "against-the-endless-queue").map(clone);
  return authored.map(clone);
}

function clone(reading: Reading): Reading {
  return { ...reading, connections: [...reading.connections], tensions: [...reading.tensions], tags: [...reading.tags], lastAttempt: reading.lastAttempt ? { ...reading.lastAttempt } : undefined };
}

export type ProviderState = "missing" | "connected" | "invalid" | "removed";

export const PROVIDER_COPY: Record<ProviderState, { status: string; note: string }> = {
  missing: { status: "No key connected", note: "Saving and reprocessing need your OpenAI key. Your library stays readable without one." },
  connected: { status: "Connected · OpenAI key ending 4f2a", note: "Reading Lite sends your key to OpenAI for each summary and embedding. You pay OpenAI directly." },
  invalid: { status: "Key rejected by OpenAI", note: "Replace the key to resume processing. Requests already sent may still finish and be charged." },
  removed: { status: "Key removed", note: "No further requests use it. Your library, sources, and search stay available." },
};

export function spendLabel(charged: number, cap: number): string {
  return `$${charged.toFixed(2)} of $${cap.toFixed(2)} today`;
}

export function todayIso(): string {
  return STUDY_NOW;
}
