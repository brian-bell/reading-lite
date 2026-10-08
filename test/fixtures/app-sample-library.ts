// The public sample library app/ bundles (reading-lite-gh341.10).
//
// Signed-out readers see a curated few readings from the local fixture pack
// (#366) before they have a key, so the frontend ships them as static content
// rather than reading a sample tenant: no unauthenticated backend read path
// exists for them. This module projects the chosen fixtures out of the
// browser-evidence snapshot (app-fixture-pack.ts) into
// app/src/samples/sample-library.json, which `npm run fixtures:app` writes
// alongside the pack and test/unit/operator-guards.test.ts keeps in
// step with it.
//
// The projection keeps what the reading page renders from a ready reading and
// nothing an operator reads: no attempts, usage, hashes, sizes, or dates of
// capture. Each reading is addressed by its URL's last path segment, and its
// connections and tensions are kept only where the target is itself a sample,
// so every relationship a sample shows leads to another sample.

import type { GetReadingResponse } from "../../src/schemas/api";
import { APP_FIXTURE_PACK_COMMAND, buildAppFixturePack } from "./app-fixture-pack";

/** Repo-relative path of the generated file. */
export const APP_SAMPLE_LIBRARY_PATH = "app/src/samples/sample-library.json";

/**
 * Fixture names (docs/design/connected/fixture-pack.md), in the order the
 * sample library lists them: the tension pair and the reading both connect
 * to, two that connect back to it, and one the archive had nothing close to.
 */
export const APP_SAMPLE_FIXTURES = [
  "attention",
  "friction",
  "gardens",
  "reprocess-failed",
  "imported-markdown",
  "sparse-archive",
] as const;

export interface SampleTarget {
  url: string;
  title?: string;
  status: string;
}

export interface SampleReading {
  id: string;
  url: string;
  status: "ready";
  title: string;
  tldr?: string;
  summary_markdown?: string;
  tags?: string[];
  keywords?: string[];
  people?: string[];
  orgs?: string[];
  source_type?: string;
  source_date?: string;
  novelty_verdict?: string;
  similarity?: { count?: number };
  connections?: { id: string; reason: string }[];
  connections_computed_at?: string;
  tensions?: { id: string; kind: string; reason: string }[];
  relationship_targets: Record<string, SampleTarget>;
}

export interface AppSampleLibrary {
  regenerate_with: string;
  readings: SampleReading[];
}

/** The URL's last path segment: `https://fieldnotes.example/2026/a-quieter-internet` is `a-quieter-internet`. */
export function sampleSlug(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const slug = segments.at(-1);
  if (!slug) throw new Error(`sample URL has no path segment: ${url}`);
  return slug;
}

export function buildAppSampleLibrary(): AppSampleLibrary {
  const pack = buildAppFixturePack();
  const chosen = APP_SAMPLE_FIXTURES.map((name) => {
    const fixture = pack.fixtures.find((f) => f.name === name);
    if (!fixture) throw new Error(`no fixture named ${name}`);
    return pack.readings[fixture.id];
  });
  const slugs = new Map(chosen.map((reading) => [reading.id, sampleSlug(reading.url)]));
  return {
    regenerate_with: APP_FIXTURE_PACK_COMMAND,
    readings: chosen.map((reading) => sampleReading(reading, slugs)),
  };
}

function sampleReading(reading: GetReadingResponse, slugs: Map<string, string>): SampleReading {
  if (reading.status !== "ready" || !reading.title) {
    throw new Error(`sample ${reading.id} must be a ready reading with a title`);
  }
  const connections = (reading.connections ?? []).flatMap((c) =>
    slugs.has(c.id) ? [{ id: slugs.get(c.id)!, reason: c.reason }] : [],
  );
  const tensions = (reading.tensions ?? []).flatMap((t) =>
    slugs.has(t.id) ? [{ id: slugs.get(t.id)!, kind: t.kind, reason: t.reason }] : [],
  );
  const targets: Record<string, SampleTarget> = {};
  for (const [id, target] of Object.entries(reading.relationship_targets)) {
    const slug = slugs.get(id);
    if (slug) targets[slug] = { url: target.url, title: target.title ?? undefined, status: target.status };
  }
  return {
    id: slugs.get(reading.id)!,
    url: reading.url,
    status: "ready",
    title: reading.title,
    tldr: reading.tldr,
    summary_markdown: reading.summary_markdown,
    tags: reading.tags,
    keywords: reading.keywords,
    people: reading.people,
    orgs: reading.orgs,
    source_type: reading.source_type,
    source_date: reading.source_date,
    novelty_verdict: reading.novelty_verdict,
    similarity: reading.similarity ? { count: reading.similarity.count } : undefined,
    connections: connections.length > 0 ? connections : undefined,
    connections_computed_at: connections.length > 0 ? reading.connections_computed_at : undefined,
    tensions: tensions.length > 0 ? tensions : undefined,
    relationship_targets: targets,
  };
}

/** The file's exact bytes, so the emitter and the drift test agree. */
export function serializeAppSampleLibrary(library: AppSampleLibrary): string {
  return `${JSON.stringify(library, null, 2)}\n`;
}
