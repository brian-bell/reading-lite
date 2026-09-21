// The property the incremental tier-1 scope has to hold, on generated corpora:
//
//   A. the incremental report IS the full report restricted to what the pass
//      measured — same readings, same flags, same neighbour lists, byte for
//      byte apart from the scope header; and
//   B. no drift hides in the gap: every reading whose flags moved between the
//      previous full run and this one is inside the scope.
//
// The corpora are generated from a seeded PRNG rather than hand-written, and
// scored by a fixed 1-D distance function, so the neighbourhoods are internally
// consistent the way a real similarity scan is: the same pair scores the same
// in a forward query and in a reverse one. That consistency is what makes B a
// real test of the reverse bound rather than a test of the fixture.
//
// The mutation is additions and reprocess-in-place. A vector that MOVES far
// enough to leave a stranger's floored neighbourhood is the known gap the
// weekly full sweep exists for (refresh-scope.ts header), and a purge escalates
// to a full sweep by construction, so neither is generated here.

import { describe, expect, it } from "vitest";
import {
  corpusRefreshNeighboursCommand,
  type CorpusRefreshNeighboursDeps,
} from "../../../scripts/ops-lib/commands/corpus-refresh-neighbours";
import type { CommandIo } from "../../../scripts/ops-lib/contract";
import type { RefreshRow } from "../../../scripts/corpus-lib/refresh-neighbours";
import {
  REFRESH_STATE_VERSION,
  REVERSE_TOP_K,
  type RefreshState,
} from "../../../scripts/corpus-lib/refresh-scope";
import { REFRESH_CANDIDATE_TOP_K } from "../../../src/modules/refresh-neighbours";
import { SIMILARITY_FLOOR, SIMILAR_TOP_K } from "../../../src/modules/stores/similarity-store";

/** Every pass addresses one tenant's rows. */
const TENANT = "usr_11111111-1111-4111-8111-111111111111";
const T0 = "2026-08-01T00:00:00.000Z";
const MARKER_AT = "2026-08-20T00:00:00.000Z";
const T1 = "2026-08-25T00:00:00.000Z";
const NOW = "2026-08-26T00:00:00.000Z";

/**
 * Width of the generated 1-D "embedding space". Wide enough that a corpus has
 * both near pairs (above the similarity floor) and strangers below the reverse
 * bound — in a space narrow enough that every reading is everyone's neighbour,
 * every reverse query saturates and every seed escalates to a full sweep, which
 * would leave the properties below comparing a full pass with itself.
 */
const SPACE = 3;

interface Reading {
  id: string;
  /** Position in a 1-D "embedding space"; the score is a function of distance. */
  position: number;
  createdAt: string;
  updatedAt: string;
  connections: { id: string; reason: string }[];
  neighbourhoodIds?: string[];
  verdict: "novel" | "familiar";
}

/** mulberry32: a seeded PRNG, so a failure is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cosine-like: identical positions score 1, and the score falls linearly with
// distance, crossing both the similarity floor and the reverse bound within the
// range the generator uses.
function score(a: Reading, b: Reading): number {
  return Math.max(0, 1 - Math.abs(a.position - b.position));
}

function listRow(reading: Reading): RefreshRow {
  return {
    id: reading.id,
    url: `https://example.com/${reading.id}`,
    status: "ready",
    key_prefix: `readings/${reading.id}`,
    created_at: reading.createdAt,
    updated_at: reading.updatedAt,
  };
}

function manifest(reading: Reading): Record<string, unknown> {
  return {
    id: reading.id,
    url: `https://example.com/${reading.id}`,
    url_hash: "a".repeat(64),
    status: "ready",
    title: `Title ${reading.id}`,
    tldr: `TLDR ${reading.id}`,
    tags: ["ai"],
    keywords: ["one", "two", "three"],
    people: [],
    orgs: [],
    summary_markdown: "body",
    novelty_verdict: reading.verdict,
    connections: reading.connections,
    ...(reading.neighbourhoodIds === undefined
      ? {}
      : { connections_neighbourhood_ids: reading.neighbourhoodIds }),
    connections_computed_at: reading.updatedAt,
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: reading.createdAt,
    updated_at: reading.updatedAt,
  };
}

function makeDeps(corpus: Reading[], state: RefreshState | null) {
  const byId = new Map(corpus.map((reading) => [reading.id, reading]));
  const lines: string[] = [];
  const io: CommandIo = { stdout: (t) => lines.push(t), stderr: (t) => lines.push(t) };
  const queried: Array<{ id: string; topK: number }> = [];
  const reports: string[] = [];
  const deps: CorpusRefreshNeighboursDeps = {
    io,
    withStore: (_target, work) =>
      work({
        listItems: async () => corpus.map(listRow),
        readRefreshState: async () => state,
        writeRefreshState: async () => {},
        readManifest: async (id) => {
          const reading = byId.get(id);
          return reading === undefined ? null : manifest(reading);
        },
        queryByVectorId: async (id, topK) => {
          queried.push({ id, topK });
          const self = byId.get(id);
          if (self === undefined) return null;
          return corpus
            .map((other) => ({
              id: other.id,
              score: score(self, other),
              title: `Title ${other.id}`,
              created_at: other.createdAt,
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
        },
        setSimilarity: async () => true,
      }),
    now: () => Date.parse(NOW),
    mkdir: async () => {},
    writeFile: async (_path, body) => {
      reports.push(body);
    },
  };
  return { deps, lines, queried, reports };
}

interface RunResult {
  code: number;
  report: { readings: Array<{ id: string; reasons: string[] }> };
  /** The ids the pass actually measured (a forward, metadata-bearing query). */
  measured: Set<string>;
}

async function run(corpus: Reading[], argv: string[], state: RefreshState | null): Promise<RunResult> {
  const { deps, queried, reports } = makeDeps(corpus, state);
  const code = await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, ...argv], deps);
  return {
    code,
    report: JSON.parse(reports[reports.length - 1]!),
    measured: new Set(
      queried.filter((q) => q.topK === REFRESH_CANDIDATE_TOP_K).map((q) => q.id),
    ),
  };
}

/** A corpus whose citations follow from its own geometry, as a judged one would. */
function generateCorpus(rand: () => number, size: number, createdAt: string): Reading[] {
  const readings: Reading[] = [];
  for (let i = 0; i < size; i++) {
    readings.push({
      id: `rd_${createdAt.slice(8, 10)}_${i}`,
      position: rand() * SPACE,
      createdAt,
      updatedAt: createdAt,
      connections: [],
      verdict: "novel",
    });
  }
  for (const reading of readings) {
    const neighbours = readings
      .filter((other) => other.id !== reading.id && score(reading, other) >= SIMILARITY_FLOOR)
      .sort((a, b) => score(reading, b) - score(reading, a))
      .slice(0, SIMILAR_TOP_K);
    // Cite most floored neighbours, leave some as considered-but-rejected: both
    // sides of the tier-1 diff need to be exercised.
    reading.connections = neighbours
      .filter(() => rand() > 0.25)
      .map((other) => ({ id: other.id, reason: `about ${other.id}` }));
    reading.neighbourhoodIds = neighbours.map((other) => other.id);
    reading.verdict = neighbours.length > 0 ? "familiar" : "novel";
  }
  return readings;
}

function flagsById(report: RunResult["report"]): Map<string, string> {
  return new Map(report.readings.map((r) => [r.id, [...r.reasons].sort().join(",")]));
}

describe("incremental tier-1 scope, on generated corpora", () => {
  it("reports exactly what a full pass reports for the readings it measured", async () => {
    // Both properties are vacuous on a seed that escalated to a full sweep —
    // "measured" is then every id and each assertion compares a full pass with
    // itself — so the seeds that actually narrowed are counted and required.
    let narrowed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rand = prng(seed);
      const before = generateCorpus(rand, 4 + Math.floor(rand() * 8), T0);
      const after = mutate(before, rand);
      const marker: RefreshState = {
        version: REFRESH_STATE_VERSION,
        last_run_at: MARKER_AT,
        list_ids: before.map((reading) => reading.id),
      };

      const full = await run(after, ["--full"], marker);
      const incremental = await run(after, ["--since-last-run"], marker);
      expect(full.code, `seed ${seed}`).toBe(0);
      expect(incremental.code, `seed ${seed}`).toBe(0);

      // Property A. Restriction, not resemblance: every field of every reading.
      expect(incremental.report.readings, `seed ${seed}`).toEqual(
        full.report.readings.filter((reading) => incremental.measured.has(reading.id)),
      );
      if (incremental.measured.size < full.measured.size) narrowed++;
      // Property B. Nothing whose flags moved is outside the scope.
      const beforeFlags = flagsById((await run(before, ["--full"], null)).report);
      const afterFlags = flagsById(full.report);
      for (const id of new Set([...beforeFlags.keys(), ...afterFlags.keys()])) {
        if ((beforeFlags.get(id) ?? "") === (afterFlags.get(id) ?? "")) continue;
        expect(
          incremental.measured.has(id),
          `seed ${seed}: flags of ${id} moved but it was never measured`,
        ).toBe(true);
      }
    }
    // A handful of narrowing seeds is what keeps the two properties above from
    // being forty comparisons of a full pass with itself.
    expect(narrowed).toBeGreaterThanOrEqual(5);
  });

  it("measures fewer readings than a full pass on at least some corpora", async () => {
    // Guards against the scope quietly degenerating to "everything", which
    // would satisfy both properties above and deliver none of the speedup.
    let narrowed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rand = prng(seed);
      const before = generateCorpus(rand, 6 + Math.floor(rand() * 6), T0);
      const after = mutate(before, rand);
      const incremental = await run(after, ["--since-last-run"], {
        version: REFRESH_STATE_VERSION,
        last_run_at: MARKER_AT,
        list_ids: before.map((reading) => reading.id),
      });
      if (incremental.measured.size < after.length) narrowed++;
    }
    expect(narrowed).toBeGreaterThan(0);
  });

  it("asks for topK 100 on every reverse query", async () => {
    const rand = prng(7);
    const before = generateCorpus(rand, 6, T0);
    const after = mutate(before, rand);
    const { deps, queried } = makeDeps(after, {
      version: REFRESH_STATE_VERSION,
      last_run_at: MARKER_AT,
      list_ids: before.map((reading) => reading.id),
    });
    await corpusRefreshNeighboursCommand.run(["--tenant", TENANT, "--since-last-run"], deps);
    const reverse = queried.filter((q) => q.topK !== REFRESH_CANDIDATE_TOP_K);
    expect(reverse.length).toBeGreaterThan(0);
    for (const query of reverse) expect(query.topK).toBe(REVERSE_TOP_K);
  });
});

/** Additions and reprocess-in-place: the two changes a nightly run must catch. */
function mutate(before: Reading[], rand: () => number): Reading[] {
  const added = generateCorpus(rand, 1 + Math.floor(rand() * 3), T1);
  const after = before.map((reading) =>
    rand() > 0.75 ? { ...reading, updatedAt: T1 } : { ...reading },
  );
  // The additions are judged against nothing: a brand-new reading arrives with
  // whatever the ingest wrote, which is exactly what tier 1 then flags.
  for (const reading of added) {
    reading.connections = [];
    reading.neighbourhoodIds = [];
    reading.verdict = "novel";
  }
  return [...after, ...added];
}
