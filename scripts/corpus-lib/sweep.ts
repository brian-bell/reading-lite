// Pure planner for `corpus-sweep`: finds readings that are the *same resource*
// stored under different URL spellings, and decides which copy survives.
//
// Why this exists separately from `corpus-drop`. By-url ownership
// (`index/by-url/{sha256(url)}`) is keyed on the exact submitted URL, so
// `https://youtu.be/X` and `https://www.youtube.com/watch?v=X` claim two
// different slots and both reach `ready`. Nothing in the write path can see
// that they are one video, and `corpus-drop` — which matches selectors by exact
// URL equality — cannot reconcile them either.
//
// The result is a duplicate pair of *ready* readings, which `corpus-drop`
// refuses on production because a ready reading owns a Vectorize embedding that
// a blind drop would dangle. Sweep can safely go where drop won't, because it
// carries a stronger invariant than "never touch ready":
//
//   1. A drop is only ever proposed as part of a group that keeps a survivor,
//      so the resource never leaves the corpus entirely.
//   2. Every ready drop is reported in `readyDropCount`, and the CLI refuses to
//      run without a Vectorize index, so the embedding goes with the reading.
//
// This module is deliberately pure and offline: URL canonicalization and keeper
// choice are the parts worth testing, and they need no R2.

export interface SweepItem {
  id: string;
  url: string;
  key_prefix: string;
  status: string;
  created_at: string;
  title?: string;
  tldr?: string;
  tags?: string[];
  keywords?: string[];
}

export interface SweepGroup {
  // The canonical URL the group's members all collapse onto.
  key: string;
  items: SweepItem[];
  keeper: SweepItem;
  drops: SweepItem[];
  // Why this keeper won — shown in the CLI plan so the choice is reviewable.
  reason: string;
}

export interface SweepPlan {
  groups: SweepGroup[];
  errors: string[];
  // How many drops are `ready` and therefore also own a Vectorize vector.
  readyDropCount: number;
}

export interface SweepOptions {
  // Restrict the sweep to groups touched by these ids/urls. Empty = all groups.
  only?: string[];
  // Force a specific id to be the keeper of its group, overriding the ranking.
  keep?: string[];
}

// Query params that carry no identity — tracking, referral and playback
// position. Dropping them lets two links to the same page collapse, while any
// other param (`?page=2`, `?id=7`) is kept because it can select real content.
const NOISE_PARAMS = new Set([
  "si", "feature", "app", "ref", "ref_src", "ref_url", "source",
  "fbclid", "gclid", "mc_cid", "mc_eid", "igshid",
  "share_id", "correlation_id", "post_fullname", "rdt",
  "t", "start", "time_continue",
]);

// Every `utm_*` key is tracking, so match the prefix rather than enumerating.
// Reddit's iOS share sheet emits `utm_name`, which an enumerated list missed.
const isNoiseParam = (k: string): boolean =>
  NOISE_PARAMS.has(k.toLowerCase()) || k.toLowerCase().startsWith("utm_");

const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"]);
const YOUTUBE_PATH_FORMS = ["/shorts/", "/embed/", "/live/", "/v/"];

// Every YouTube URL form reduced to one watch URL, so the short link, the
// mobile link, a Shorts link and an embed all land on the same key. Returns
// null when `u` is not a YouTube video URL.
function youtubeCanonical(u: URL, host: string): string | null {
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return id ? `https://youtube.com/watch?v=${id}` : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (u.pathname === "/watch") {
    const id = u.searchParams.get("v");
    return id ? `https://youtube.com/watch?v=${id}` : null;
  }
  for (const form of YOUTUBE_PATH_FORMS) {
    if (u.pathname.startsWith(form)) {
      const id = u.pathname.slice(form.length).split("/")[0];
      if (id) return `https://youtube.com/watch?v=${id}`;
    }
  }
  return null;
}

const REDDIT_HOSTS = new Set(["reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "amp.reddit.com"]);

// A Reddit thread reduced to its base36 post id. The subreddit, the title slug
// and a trailing `/comment/<comment_id>` permalink are all decoration around
// the same thread — and `reddit-import` imports the whole thread (post + top
// comments) regardless of which of those URLs was submitted, so every form
// yields the same reading. Returns null for non-thread Reddit URLs (a
// subreddit or user page), which are left to the generic rule.
function redditCanonical(u: URL, host: string): string | null {
  if (host === "redd.it") {
    const id = u.pathname.slice(1).split("/")[0];
    return /^[a-z0-9]+$/i.test(id) ? `https://reddit.com/comments/${id}` : null;
  }
  if (!REDDIT_HOSTS.has(host)) return null;
  const m = /^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)/i.exec(u.pathname);
  return m ? `https://reddit.com/comments/${m[1]}` : null;
}

// A stable identity key for a URL: same resource → same string. Host is
// lowercased and de-`www`'d, scheme is forced to https, the fragment and noise
// params are dropped, remaining params are sorted, and a trailing slash is
// trimmed. Path case is preserved — many sites serve case-sensitive paths.
//
// Unparseable input is returned verbatim rather than thrown away, so a
// malformed stored URL still groups with an identical malformed one.
export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  const yt = youtubeCanonical(u, host);
  if (yt) return yt;

  const rd = redditCanonical(u, host);
  if (rd) return rd;

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !isNoiseParam(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
  const path = u.pathname.replace(/\/+$/, "");
  return `https://${host}${path}${query}`;
}

// Groups readings by canonical URL, returning only the groups with more than
// one member — i.e. the actual duplicates. Group order follows first
// appearance in `items` so the CLI plan is stable across runs.
export function findDuplicateGroups(items: SweepItem[]): Array<{ key: string; items: SweepItem[] }> {
  const byKey = new Map<string, SweepItem[]>();
  for (const it of items) {
    const key = canonicalizeUrl(it.url);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(it);
    else byKey.set(key, [it]);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, items: group }));
}

// How much a copy is worth keeping. Length of the summary plus the breadth of
// its tags/keywords is a good proxy for how much source text the summarizer
// actually had: a thin worker-made YouTube reading (metadata floor, no
// transcript) scores far below the same video imported with its transcript.
function richness(it: SweepItem): number {
  const tldr = it.tldr?.length ?? 0;
  const breadth = (it.keywords?.length ?? 0) + (it.tags?.length ?? 0);
  return tldr + breadth * 10;
}

// Ranks a group best-first: ready beats non-ready (a non-ready copy has no
// summary to lose), then richer beats thinner, then newer beats older — the
// newer copy is usually the deliberate re-import that prompted the cleanup.
function rank(a: SweepItem, b: SweepItem): number {
  const ready = (i: SweepItem): number => (i.status === "ready" ? 1 : 0);
  if (ready(a) !== ready(b)) return ready(b) - ready(a);
  const r = richness(b) - richness(a);
  if (r !== 0) return r;
  return b.created_at.localeCompare(a.created_at);
}

function reasonFor(keeper: SweepItem, rest: SweepItem[], forced: boolean): string {
  if (forced) return "kept by --keep";
  if (keeper.status === "ready" && rest.every((i) => i.status !== "ready")) return "only ready copy";
  if (rest.some((i) => richness(i) !== richness(keeper))) return "richest summary";
  return "newest copy";
}

export function planSweep(items: SweepItem[], opts: SweepOptions = {}): SweepPlan {
  const only = opts.only ?? [];
  const keep = opts.keep ?? [];
  const errors: string[] = [];

  let groups = findDuplicateGroups(items);

  if (only.length > 0) {
    const wantedIds = new Set(only.filter((s) => s.startsWith("rd_")));
    const wantedKeys = new Set(only.filter((s) => !s.startsWith("rd_")).map(canonicalizeUrl));
    const matched = new Set<string>();
    groups = groups.filter((g) => {
      const hit = [...wantedIds].filter((id) => g.items.some((i) => i.id === id));
      const keyHit = wantedKeys.has(g.key);
      for (const id of hit) matched.add(id);
      if (keyHit) matched.add(g.key);
      return hit.length > 0 || keyHit;
    });
    for (const sel of only) {
      const key = sel.startsWith("rd_") ? sel : canonicalizeUrl(sel);
      if (!matched.has(key)) errors.push(`not part of any duplicate group: ${sel}`);
    }
  }

  // A --keep id must name exactly one group, and no group may be named twice:
  // both cases mean the operator's intent doesn't match the corpus, and
  // guessing on their behalf is how the wrong copy gets deleted.
  const forcedByGroupKey = new Map<string, SweepItem>();
  for (const id of keep) {
    const owning = groups.filter((g) => g.items.some((i) => i.id === id));
    if (owning.length === 0) {
      errors.push(`--keep ${id} is not part of any duplicate group in this sweep`);
      continue;
    }
    const g = owning[0];
    if (forcedByGroupKey.has(g.key)) {
      errors.push(`--keep names more than one id in the same duplicate group (${g.key}): ${id}`);
      continue;
    }
    forcedByGroupKey.set(g.key, g.items.find((i) => i.id === id)!);
  }

  if (errors.length > 0) return { groups: [], errors, readyDropCount: 0 };

  const planned: SweepGroup[] = groups.map((g) => {
    const ordered = [...g.items].sort(rank);
    const forced = forcedByGroupKey.get(g.key);
    const keeper = forced ?? ordered[0];
    const drops = g.items.filter((i) => i.id !== keeper.id);
    return {
      key: g.key,
      items: g.items,
      keeper,
      drops,
      reason: reasonFor(keeper, drops, forced !== undefined),
    };
  });

  const readyDropCount = planned.reduce(
    (n, g) => n + g.drops.filter((d) => d.status === "ready").length,
    0,
  );
  return { groups: planned, errors, readyDropCount };
}

// An operator-asserted duplicate: two readings that are the same *material* but
// not the same *resource*, so no canonicalization rule can pair them — a video
// and the tweet arguing the same thing, an article and its conference talk.
// Merging those by URL would be wrong (x.com is not youtube.com), so the
// assertion has to come from the operator.
//
// The result is a normal one-group SweepPlan, which keeps every safety property
// the canonical path has: exactly one survivor, and the drop's vector deleted
// with it. The keeper must be `ready` — dropping a summarized reading in favour
// of a failed or pending one would destroy the surviving content.
export function planExplicitPair(
  items: SweepItem[],
  sel: { drop: string; keep: string },
): SweepPlan {
  const errors: string[] = [];
  if (sel.drop === sel.keep) {
    return { groups: [], errors: [`--drop and --keep name the same reading: ${sel.drop}`], readyDropCount: 0 };
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const drop = byId.get(sel.drop);
  const keep = byId.get(sel.keep);
  if (!drop) errors.push(`id not found in index/list.json: ${sel.drop}`);
  if (!keep) errors.push(`id not found in index/list.json: ${sel.keep}`);
  if (errors.length > 0) return { groups: [], errors, readyDropCount: 0 };

  if (keep!.status !== "ready") {
    return {
      groups: [],
      errors: [`refusing to keep ${keep!.id}: it is ${keep!.status}, not ready — the surviving copy must carry the summary`],
      readyDropCount: 0,
    };
  }

  return {
    groups: [{
      key: `${canonicalizeUrl(keep!.url)} (asserted)`,
      items: [keep!, drop!],
      keeper: keep!,
      drops: [drop!],
      reason: "asserted duplicate via --drop/--keep",
    }],
    errors: [],
    readyDropCount: drop!.status === "ready" ? 1 : 0,
  };
}
