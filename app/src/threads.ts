import type { Reading } from "./reading";
import type { GraphReading, GraphRow, RelationshipGraph } from "./relationships";
import { tensionKindLabel } from "./reading-relationships";

// What the frontend derives from the relationship graph (design spec,
// Derivations in the frontend): threads, the library's tension pairs, the
// thread a reading is in, Worth revisiting, and a library card's counts.
// Ported from the next-direction prototype's study.ts. Pure: the server
// render and the browser compute the same answer, so names and order are
// compared by code point, never by locale.

/** Above this many readings, a connected component is split by tag. */
export const THREAD_SPLIT_ABOVE = 12;

/** A connection saved this long before the reading is worth revisiting. A product rule. */
export const REVISIT_AFTER_MS = 60 * 86_400_000;

export interface Thread {
  /** The oldest reading's id. `/threads/$id` takes any member's id instead (see threadFor). */
  id: string;
  name: string;
  /** Oldest first by `created_at`, then id. */
  readings: GraphReading[];
  /** Tension pairs with both ends in this thread. */
  tensions: number;
  /** The newest reading's `created_at`. */
  updatedAt: string;
}

export interface TensionPair {
  a: GraphReading;
  b: GraphReading;
  /** Active voice: `superseded_by` and `qualified_by` are read from the other side. */
  kind: string;
  label: string;
  reason: string;
}

function byCodePoint(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function oldestFirst(x: GraphReading, y: GraphReading): number {
  return Date.parse(x.created_at) - Date.parse(y.created_at) || byCodePoint(x.id, y.id);
}

/** Each tag once per reading, counted over `readings`, most common first, ties by code point. */
function tagsByCount(readings: readonly GraphReading[]): [tag: string, count: number][] {
  const counts = new Map<string, number>();
  for (const reading of readings) {
    for (const tag of new Set(reading.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].sort((x, y) => y[1] - x[1] || byCodePoint(x[0], y[0]));
}

/** Undirected components over the ready readings: every connection and tension joins its two ends. */
function components(graph: RelationshipGraph): GraphReading[][] {
  const ready = graph.readings.filter((reading) => reading.status === "ready");
  const parent = new Map(ready.map((reading) => [reading.id, reading.id]));
  const root = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    parent.set(id, at);
    return at;
  };
  for (const row of graph.relationships) {
    if (!parent.has(row.source_id) || !parent.has(row.target_id)) continue;
    parent.set(root(row.source_id), root(row.target_id));
  }
  const groups = new Map<string, GraphReading[]>();
  for (const reading of ready) {
    const at = root(reading.id);
    groups.set(at, [...(groups.get(at) ?? []), reading]);
  }
  return [...groups.values()];
}

/**
 * A component of more than THREAD_SPLIT_ABOVE readings, split by tag: each
 * reading joins the group of its own tag that is most common in the
 * component. A reading with no tags, and every group of one, joins the
 * largest group. Groups are not split again.
 */
function splitByTag(component: GraphReading[]): GraphReading[][] {
  const counts = new Map(tagsByCount(component));
  const groups = new Map<string, GraphReading[]>();
  const untagged: GraphReading[] = [];
  for (const reading of component) {
    const [tag] = [...new Set(reading.tags ?? [])].sort((x, y) => counts.get(y)! - counts.get(x)! || byCodePoint(x, y));
    if (tag === undefined) untagged.push(reading);
    else groups.set(tag, [...(groups.get(tag) ?? []), reading]);
  }
  const ranked = [...groups].sort((x, y) => y[1].length - x[1].length || byCodePoint(x[0], y[0]));
  if (ranked.length === 0) return [component];
  const [[, largest], ...rest] = ranked as [[string, GraphReading[]], ...[string, GraphReading[]][]];
  const kept = [largest];
  for (const [, members] of rest) {
    if (members.length === 1) largest.push(...members);
    else kept.push(members);
  }
  largest.push(...untagged);
  return kept;
}

/** Tag words whose written form is not lowercase. A Map, so "constructor" is not read off Object.prototype. */
const TAG_WORDS = new Map<string, string>([
  ["agi", "AGI"],
  ["ai", "AI"],
  ["api", "API"],
  ["apis", "APIs"],
  ["cli", "CLI"],
  ["cpu", "CPU"],
  ["css", "CSS"],
  ["gpu", "GPU"],
  ["html", "HTML"],
  ["http", "HTTP"],
  ["ios", "iOS"],
  ["javascript", "JavaScript"],
  ["llm", "LLM"],
  ["llms", "LLMs"],
  ["macos", "macOS"],
  ["ml", "ML"],
  ["nlp", "NLP"],
  ["rag", "RAG"],
  ["sql", "SQL"],
  ["typescript", "TypeScript"],
  ["ui", "UI"],
  ["ux", "UX"],
]);

/** A canonical tag as a reader would write it: "developer-tools" is "Developer tools", "ai-safety" is "AI safety". */
function tagLabel(tag: string): string {
  return tag
    .toLowerCase()
    .split(/[-\s]+/)
    .filter((word) => word !== "")
    .map((word, i) => TAG_WORDS.get(word) ?? (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * The thread's tags, best name first. A tag that more than half its readings
 * share comes first; then the tag most particular to the thread, the one with
 * the largest share of its library readings inside the thread, so a broad tag
 * such as "ai" does not name every thread. Shares compare by cross-multiplying
 * integers, so the server render and the browser rank alike.
 */
function namingTags(readings: readonly GraphReading[], libraryCounts: ReadonlyMap<string, number>): string[] {
  const majority = (count: number) => (count * 2 > readings.length ? 1 : 0);
  return tagsByCount(readings)
    .sort(
      ([xt, xc], [yt, yc]) =>
        majority(yc) - majority(xc) ||
        yc * libraryCounts.get(xt)! - xc * libraryCounts.get(yt)! ||
        yc - xc ||
        byCodePoint(xt, yt),
    )
    .map(([tag]) => tag);
}

/**
 * The library's threads, most recently extended first: components of two or
 * more ready readings, split by tag above THREAD_SPLIT_ABOVE. A ready reading
 * in no thread stands alone (see `standingAlone`).
 */
export function threadsOf(graph: RelationshipGraph): Thread[] {
  const pairs = tensionPairs(graph);
  const libraryCounts = new Map(tagsByCount(graph.readings.filter((reading) => reading.status === "ready")));
  const threads: (Thread & { tags: string[] })[] = [];
  for (const component of components(graph)) {
    if (component.length < 2) continue;
    const groups = component.length > THREAD_SPLIT_ABOVE ? splitByTag(component) : [component];
    for (const group of groups) {
      const readings = [...group].sort(oldestFirst);
      const ids = new Set(readings.map((reading) => reading.id));
      const tags = namingTags(readings, libraryCounts);
      threads.push({
        id: readings[0]!.id,
        name: tags[0] === undefined ? (readings[0]!.title ?? readings[0]!.url) : tagLabel(tags[0]),
        tags,
        readings,
        tensions: pairs.filter((pair) => ids.has(pair.a.id) && ids.has(pair.b.id)).length,
        updatedAt: readings.at(-1)!.created_at,
      });
    }
  }
  // Threads that share a name take their next tag too: "AI · Evaluation" and "AI · Agents".
  const named = new Map<string, number>();
  for (const thread of threads) named.set(thread.name, (named.get(thread.name) ?? 0) + 1);
  const result = threads.map(({ tags, ...thread }) =>
    named.get(thread.name)! > 1 && tags[1] !== undefined ? { ...thread, name: `${thread.name} · ${tagLabel(tags[1])}` } : thread,
  );
  return result.sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt) || byCodePoint(x.id, y.id));
}

/** Ready readings in no thread, newest first. */
export function standingAlone(graph: RelationshipGraph, threads: readonly Thread[]): GraphReading[] {
  const inThread = new Set(threads.flatMap((thread) => thread.readings.map((reading) => reading.id)));
  return graph.readings
    .filter((reading) => reading.status === "ready" && !inThread.has(reading.id))
    .sort((x, y) => oldestFirst(y, x));
}

/** The thread containing `readingId`, so a link by any member's id outlives a change of oldest reading. */
export function threadFor(threads: readonly Thread[], readingId: string): Thread | undefined {
  return threads.find((thread) => thread.readings.some((reading) => reading.id === readingId));
}

const ACTIVE_VOICE: Record<string, string> = { superseded_by: "supersedes", qualified_by: "qualifies" };

/**
 * One pair per unordered {a, b} of ready readings, as threads are, from
 * whichever side's row reads in the active voice, newest first by the later of
 * the two readings. Tensions are stored on both sides with inverse kinds and
 * the same reason.
 */
export function tensionPairs(graph: RelationshipGraph): TensionPair[] {
  const byId = new Map(graph.readings.map((reading) => [reading.id, reading]));
  const pairs = new Map<string, TensionPair>();
  const flippedKeys = new Set<string>();
  for (const row of graph.relationships) {
    if (row.kind !== "tension") continue;
    const source = byId.get(row.source_id);
    const target = byId.get(row.target_id);
    if (source?.status !== "ready" || target?.status !== "ready") continue;
    const key = [source.id, target.id].sort(byCodePoint).join("|");
    const flipped = row.tension_kind === undefined ? undefined : ACTIVE_VOICE[row.tension_kind];
    // A row already in the active voice wins; otherwise the first row stands.
    if (pairs.has(key) && (flipped !== undefined || !flippedKeys.has(key))) continue;
    const kind = flipped ?? row.tension_kind ?? "tension";
    const [a, b] = flipped === undefined ? [source, target] : [target, source];
    pairs.set(key, { a, b, kind, label: tensionKindLabel(kind), reason: row.reason });
    if (flipped === undefined) flippedKeys.delete(key);
    else flippedKeys.add(key);
  }
  const later = (pair: TensionPair) => Math.max(Date.parse(pair.a.created_at), Date.parse(pair.b.created_at));
  return [...pairs.entries()]
    .sort(([kx, x], [ky, y]) => later(y) - later(x) || byCodePoint(kx, ky))
    .map(([, pair]) => pair);
}

export interface RevisitPrompt {
  id: string;
  title: string;
  url: string;
  reason: string;
  createdAt: string;
}

/**
 * Connections whose ready target was saved more than REVISIT_AFTER_MS before
 * this reading, from `relationship_targets[].created_at`, so the reading page
 * needs no tenant-wide read for them.
 */
export function revisitPrompts(reading: Reading): RevisitPrompt[] {
  if (reading.created_at === undefined) return [];
  const before = Date.parse(reading.created_at) - REVISIT_AFTER_MS;
  const prompts: RevisitPrompt[] = [];
  for (const connection of reading.connections ?? []) {
    const target = reading.relationship_targets?.[connection.id];
    if (target?.status !== "ready" || target.created_at === undefined) continue;
    if (Date.parse(target.created_at) >= before) continue;
    prompts.push({ id: connection.id, title: target.title ?? target.url, url: target.url, reason: connection.reason, createdAt: target.created_at });
  }
  return prompts;
}

/** "2 connections · 1 tension" for a library card; nothing when both are zero. */
export function relationshipCount(row: { connection_count?: number; tension_count?: number }): string | undefined {
  const parts = [counted(row.connection_count ?? 0, "connection"), counted(row.tension_count ?? 0, "tension")].filter(
    (part) => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function counted(n: number, noun: string): string | undefined {
  return n === 0 ? undefined : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The rows between two readings of one thread, from `from`'s side. */
export function rowsWithin(graph: RelationshipGraph, thread: Thread, from: string): GraphRow[] {
  const ids = new Set(thread.readings.map((reading) => reading.id));
  return graph.relationships.filter((row) => row.source_id === from && ids.has(row.target_id));
}
