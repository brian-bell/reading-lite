import { describe, expect, it } from "vitest";
import { ManifestSchema } from "../../../src/schemas/manifest";
import {
  TENSION_KEYWORD_JACCARD_MIN,
  buildTensionJudgementInput,
  deriveTensionSides,
  findOneSided,
  formatOverlapEvidence,
  inverseKind,
  isPairJudged,
  mergeTensionSide,
  overlapEvidence,
  pairKey,
  passesOverlapFilter,
  purgeTensionPartner,
  tensionCandidates,
  type RawManifest,
} from "../../../scripts/corpus-lib/refresh-tensions";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-08-31T12:00:00.000Z";
const T2 = "2026-08-31T12:05:00.000Z";

function manifest(id: string, overrides: RawManifest = {}): RawManifest {
  return {
    id,
    url: `https://example.com/${id}`,
    url_hash: "a".repeat(64),
    status: "ready",
    title: `Title ${id}`,
    tldr: `Summary ${id}`,
    tags: ["x"],
    keywords: ["alpha", "beta", "gamma"],
    people: [],
    orgs: [],
    novelty_verdict: "novel",
    connections: [],
    summary_markdown: `Stored summary ${id}.`,
    content_type: "text/html",
    content_status: "captured",
    content_bytes: 10,
    content_sha256: "b".repeat(64),
    created_at: T0,
    updated_at: T0,
    future_field: { keep: id },
    ...overrides,
  };
}

function byId(...manifests: RawManifest[]): Map<string, RawManifest> {
  return new Map(manifests.map((m) => [m.id as string, m]));
}

const ready = (...ids: string[]) => new Set(ids);

function report(rows: Array<{ id: string; neighbours: Array<[string, number]> }>) {
  return {
    readings: rows.map((row) => ({
      id: row.id,
      key_prefix: `readings/2026/${row.id}`,
      url: `https://example.com/${row.id}`,
      reasons: ["new_neighbour" as const],
      connections: [],
      current_neighbours: row.neighbours.map(([id, score]) => ({ id, score })),
    })),
  };
}

describe("overlap evidence", () => {
  it("matches people and orgs case-insensitively and keywords by Jaccard", () => {
    const a = manifest("rd_a", {
      people: ["Ada Lovelace"],
      orgs: ["Initech"],
      keywords: ["Coffee", "sleep", "caffeine"],
    });
    const b = manifest("rd_b", {
      people: ["ada  lovelace"],
      orgs: ["initech", "Acme"],
      keywords: ["coffee", "SLEEP", "heart", "study"],
      connections: [{ id: "rd_a", reason: "cites" }],
    });
    const evidence = overlapEvidence(a, b, 0.71);
    expect(evidence).toEqual({
      score: 0.71,
      people: ["ada lovelace"],
      orgs: ["initech"],
      keywords: ["coffee", "sleep"],
      keywordJaccard: 2 / 5,
      cited: ["b->a"],
    });
    expect(formatOverlapEvidence(evidence)).toBe(
      "score=0.710 people=[ada lovelace] orgs=[initech] keywords=2(0.40) cited=[b->a]",
    );
  });

  it("passes on any one rule and fails when none holds", () => {
    const base = { people: [], orgs: [], keywords: [], keywordJaccard: 0, cited: [] as never[] };
    expect(passesOverlapFilter(base)).toBe(false);
    expect(passesOverlapFilter({ ...base, people: ["ada"] })).toBe(true);
    expect(passesOverlapFilter({ ...base, orgs: ["acme"] })).toBe(true);
    expect(passesOverlapFilter({ ...base, cited: ["a->b"] })).toBe(true);
    expect(passesOverlapFilter({ ...base, keywordJaccard: TENSION_KEYWORD_JACCARD_MIN })).toBe(true);
    expect(passesOverlapFilter({ ...base, keywordJaccard: TENSION_KEYWORD_JACCARD_MIN - 0.01 })).toBe(false);
    expect(TENSION_KEYWORD_JACCARD_MIN).toBe(0.2);
  });

  it("treats tags and a bare similarity score as insufficient", () => {
    const a = manifest("rd_a", { tags: ["ai", "ops"], keywords: ["one", "two", "three"] });
    const b = manifest("rd_b", { tags: ["ai", "ops"], keywords: ["four", "five", "six"] });
    expect(passesOverlapFilter(overlapEvidence(a, b, 0.99))).toBe(false);
  });
});

describe("tensionCandidates", () => {
  it("keeps only live ready pairs that pass the pre-filter and formats evidence", () => {
    const a = manifest("rd_a", { people: ["Ada"] });
    const b = manifest("rd_b", { people: ["Ada"] });
    const c = manifest("rd_c", { keywords: ["unrelated", "words", "here"] });
    const d = manifest("rd_d", { people: ["Ada"] });
    const out = tensionCandidates(
      report([
        { id: "rd_a", neighbours: [["rd_b", 0.7], ["rd_c", 0.8], ["rd_d", 0.9], ["rd_gone", 0.9], ["rd_a", 1]] },
      ]),
      byId(a, b, c, d),
      ready("rd_a", "rd_b", "rd_c"),
    );
    expect(out.map((candidate) => candidate.key)).toEqual(["rd_a|rd_b"]);
    expect(out[0]).toMatchObject({ a: "rd_a", b: "rd_b", source: "report" });
    expect(out[0]!.evidence).toMatchObject({ score: 0.7, people: ["ada"] });
  });

  it("collapses both directions of a pair onto one canonical key with the best score", () => {
    const a = manifest("rd_a", { orgs: ["Acme"] });
    const b = manifest("rd_b", { orgs: ["Acme"] });
    const out = tensionCandidates(
      report([
        { id: "rd_b", neighbours: [["rd_a", 0.61]] },
        { id: "rd_a", neighbours: [["rd_b", 0.66], ["rd_b", 0.6]] },
      ]),
      byId(a, b),
      ready("rd_a", "rd_b"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("rd_a|rd_b");
    expect(out[0]!.evidence.score).toBe(0.66);
    expect(pairKey("rd_b", "rd_a")).toBe("rd_a|rd_b");
  });

  it("returns candidates in a deterministic order", () => {
    const mk = (id: string) => manifest(id, { people: ["Ada"] });
    const out = tensionCandidates(
      report([{ id: "rd_z", neighbours: [["rd_m", 0.7], ["rd_a", 0.7]] }]),
      byId(mk("rd_a"), mk("rd_m"), mk("rd_z")),
      ready("rd_a", "rd_m", "rd_z"),
    );
    expect(out.map((candidate) => candidate.key)).toEqual(["rd_a|rd_z", "rd_m|rd_z"]);
  });
});

describe("isPairJudged", () => {
  const judged = (partner: string, at: string) => ({ tensions_judged: [{ id: partner, judged_at: at }] });

  it("is true only when both sides remember the pair since their last rewrite", () => {
    expect(isPairJudged(manifest("rd_a", judged("rd_b", T1)), manifest("rd_b", judged("rd_a", T1)))).toBe(true);
    expect(isPairJudged(manifest("rd_a", judged("rd_b", T1)), manifest("rd_b"))).toBe(false);
    expect(isPairJudged(manifest("rd_a"), manifest("rd_b"))).toBe(false);
  });

  it("is false once either side was reprocessed after the judgement", () => {
    expect(
      isPairJudged(
        manifest("rd_a", judged("rd_b", T1)),
        manifest("rd_b", { ...judged("rd_a", T1), updated_at: T2 }),
      ),
    ).toBe(false);
    expect(
      isPairJudged(
        manifest("rd_a", { ...judged("rd_b", T1), updated_at: T2 }),
        manifest("rd_b", judged("rd_a", T1)),
      ),
    ).toBe(false);
  });

  it("ignores malformed records", () => {
    expect(
      isPairJudged(
        manifest("rd_a", { tensions_judged: [{ id: "rd_b" }] }),
        manifest("rd_b", judged("rd_a", T1)),
      ),
    ).toBe(false);
  });
});

describe("deriveTensionSides", () => {
  const ids = { a: "rd_a", b: "rd_b" };

  it("derives every verdict shape from each side's point of view", () => {
    expect(deriveTensionSides({ verdict: "none", side: null, reason: "" }, ids, T1)).toEqual({ a: null, b: null });
    expect(deriveTensionSides({ verdict: "contradicts", side: null, reason: " r " }, ids, T1)).toEqual({
      a: { id: "rd_b", kind: "contradicts", reason: "r", computed_at: T1 },
      b: { id: "rd_a", kind: "contradicts", reason: "r", computed_at: T1 },
    });
    expect(deriveTensionSides({ verdict: "supersedes", side: "a", reason: "r" }, ids, T1)).toEqual({
      a: { id: "rd_b", kind: "supersedes", reason: "r", computed_at: T1 },
      b: { id: "rd_a", kind: "superseded_by", reason: "r", computed_at: T1 },
    });
    expect(deriveTensionSides({ verdict: "supersedes", side: "b", reason: "r" }, ids, T1)).toEqual({
      a: { id: "rd_b", kind: "superseded_by", reason: "r", computed_at: T1 },
      b: { id: "rd_a", kind: "supersedes", reason: "r", computed_at: T1 },
    });
    expect(deriveTensionSides({ verdict: "qualifies", side: "a", reason: "r" }, ids, T1)).toEqual({
      a: { id: "rd_b", kind: "qualifies", reason: "r", computed_at: T1 },
      b: { id: "rd_a", kind: "qualified_by", reason: "r", computed_at: T1 },
    });
    expect(deriveTensionSides({ verdict: "qualifies", side: "b", reason: "r" }, ids, T1)).toEqual({
      a: { id: "rd_b", kind: "qualified_by", reason: "r", computed_at: T1 },
      b: { id: "rd_a", kind: "qualifies", reason: "r", computed_at: T1 },
    });
  });

  it("inverseKind is an involution and derived sides are inverses", () => {
    for (const kind of ["contradicts", "supersedes", "superseded_by", "qualifies", "qualified_by"] as const) {
      expect(inverseKind(inverseKind(kind))).toBe(kind);
    }
    const sides = deriveTensionSides({ verdict: "qualifies", side: "b", reason: "r" }, ids, T1);
    expect(inverseKind(sides.a!.kind)).toBe(sides.b!.kind);
  });
});

describe("mergeTensionSide", () => {
  const entry = { id: "rd_b", kind: "supersedes" as const, reason: "newer", computed_at: T1 };

  it("adds the entry and judged record to a manifest that had neither", () => {
    const out = mergeTensionSide(manifest("rd_a"), "rd_b", entry, T1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.tensions).toEqual([entry]);
    expect(out.manifest.tensions_judged).toEqual([{ id: "rd_b", judged_at: T1 }]);
    expect(() => ManifestSchema.parse(out.manifest)).not.toThrow();
  });

  it("replaces the partner's entry in place and keeps other partners verbatim", () => {
    const other = { id: "rd_c", kind: "contradicts", reason: "old", computed_at: T0 };
    const stale = { id: "rd_b", kind: "qualifies", reason: "old", computed_at: T0 };
    const before = manifest("rd_a", {
      tensions: [other, stale],
      tensions_judged: [{ id: "rd_c", judged_at: T0 }, { id: "rd_b", judged_at: T0 }],
    });
    const out = mergeTensionSide(before, "rd_b", entry, T1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.tensions).toEqual([other, entry]);
    expect((out.manifest.tensions as unknown[])[0]).toBe(other);
    expect(out.manifest.tensions_judged).toEqual([
      { id: "rd_c", judged_at: T0 },
      { id: "rd_b", judged_at: T1 },
    ]);
  });

  it("removes the partner's entry on a none verdict while remembering the judgement", () => {
    const other = { id: "rd_c", kind: "contradicts", reason: "old", computed_at: T0 };
    const before = manifest("rd_a", {
      tensions: [{ id: "rd_b", kind: "qualifies", reason: "old", computed_at: T0 }, other],
    });
    const out = mergeTensionSide(before, "rd_b", null, T1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.tensions).toEqual([other]);
    expect(out.manifest.tensions_judged).toEqual([{ id: "rd_b", judged_at: T1 }]);
  });

  it("does not introduce an empty tensions key or touch the judged record when asked only to drop", () => {
    const out = mergeTensionSide(manifest("rd_a"), "rd_b", null, T1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest).not.toHaveProperty("tensions");
    const before = manifest("rd_a", {
      tensions: [{ id: "rd_b", kind: "qualifies", reason: "old", computed_at: T0 }],
      tensions_judged: [{ id: "rd_b", judged_at: T0 }],
    });
    const dropped = mergeTensionSide(before, "rd_b", null);
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect(dropped.manifest.tensions).toEqual([]);
    expect(dropped.manifest.tensions_judged).toEqual([{ id: "rd_b", judged_at: T0 }]);
  });

  it("preserves every unrelated known and unknown value byte for byte", () => {
    const before = manifest("rd_a", {
      connections: [{ id: "rd_b", reason: "related" }],
      connections_computed_at: T0,
      usage: { anthropic_input_tokens: 1, anthropic_output_tokens: 2, openai_embedding_tokens: 3 },
    });
    const out = mergeTensionSide(before, "rd_b", entry, T1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { tensions: _t, tensions_judged: _j, ...rest } = out.manifest;
    expect(rest).toEqual(before);
    expect(out.manifest.updated_at).toBe(T0);
    expect(out.manifest.future_field).toBe(before.future_field);
    expect(out.manifest.connections).toBe(before.connections);
    expect(JSON.stringify(Object.keys(out.manifest).slice(0, -2))).toBe(JSON.stringify(Object.keys(before)));
  });

  it("fails closed on a mismatched entry, a non-object, or a manifest the schema rejects", () => {
    expect(mergeTensionSide(manifest("rd_a"), "rd_b", { ...entry, id: "rd_c" }, T1)).toMatchObject({ ok: false });
    expect(mergeTensionSide(null, "rd_b", entry, T1)).toMatchObject({ ok: false });
    expect(mergeTensionSide(manifest("rd_a", { content_type: undefined }), "rd_b", entry, T1)).toMatchObject({
      ok: false,
      error: expect.stringContaining("content_type"),
    });
    expect(
      mergeTensionSide(manifest("rd_a", { tensions: [{ id: "rd_c", kind: "nope" }] }), "rd_b", entry, T1),
    ).toMatchObject({ ok: false, error: expect.stringContaining("tensions") });
  });
});

describe("findOneSided", () => {
  const forward = { id: "rd_b", kind: "supersedes" as const, reason: "newer", computed_at: T1 };
  const backward = { id: "rd_a", kind: "superseded_by" as const, reason: "newer", computed_at: T1 };
  const judgedA = { id: "rd_b", judged_at: T1 };
  const judgedB = { id: "rd_a", judged_at: T1 };

  it("mirrors the inverse entry when the partner has not changed since the judgement", () => {
    const a = manifest("rd_a", { tensions: [forward], tensions_judged: [judgedA] });
    const b = manifest("rd_b");
    expect(findOneSided(byId(a, b), ready("rd_a", "rd_b"))).toEqual([
      { kind: "mirror", from: "rd_a", to: "rd_b", entry: backward },
    ]);
  });

  it("is quiet for a consistent pair", () => {
    const a = manifest("rd_a", { tensions: [forward], tensions_judged: [judgedA] });
    const b = manifest("rd_b", { tensions: [backward], tensions_judged: [judgedB] });
    expect(findOneSided(byId(a, b), ready("rd_a", "rd_b"))).toEqual([]);
  });

  it("drops the stale side when the partner was reprocessed after the judgement", () => {
    const a = manifest("rd_a", { tensions: [forward], tensions_judged: [judgedA] });
    const b = manifest("rd_b", { updated_at: T2 });
    expect(findOneSided(byId(a, b), ready("rd_a", "rd_b"))).toEqual([
      { kind: "drop", on: "rd_a", partner: "rd_b" },
    ]);
  });

  it("drops the surviving entry when the empty side remembers a newer none verdict", () => {
    // A re-judge returned none at T2: rd_a's write landed (entry removed,
    // judged T2) but rd_b's write was lost, so rd_b still holds the T1 entry.
    const a = manifest("rd_a", { tensions_judged: [{ id: "rd_b", judged_at: T2 }] });
    const b = manifest("rd_b", { tensions: [backward], tensions_judged: [judgedB] });
    expect(findOneSided(byId(a, b), ready("rd_a", "rd_b"))).toEqual([
      { kind: "drop", on: "rd_b", partner: "rd_a", judged_at: T2 },
    ]);
    // The same shape with an older judged record on the empty side is a lost
    // positive write and is mirrored as before.
    const aOlder = manifest("rd_a", { tensions_judged: [{ id: "rd_b", judged_at: T0 }] });
    expect(findOneSided(byId(aOlder, b), ready("rd_a", "rd_b"))).toEqual([
      { kind: "mirror", from: "rd_b", to: "rd_a", entry: forward },
    ]);
  });

  it("takes the newer of two disagreeing entries as the source", () => {
    const a = manifest("rd_a", { tensions: [{ ...forward, computed_at: T2, reason: "newest" }] });
    const b = manifest("rd_b", { tensions: [{ ...backward, kind: "contradicts" }] });
    expect(findOneSided(byId(a, b), ready("rd_a", "rd_b"))).toEqual([
      {
        kind: "mirror",
        from: "rd_a",
        to: "rd_b",
        entry: { id: "rd_a", kind: "superseded_by", reason: "newest", computed_at: T2 },
      },
    ]);
  });

  it("clears both sides when disagreeing entries predate the target's rewrite", () => {
    const a = manifest("rd_a", { tensions: [{ ...forward, computed_at: T1 }] });
    const b = manifest("rd_b", {
      tensions: [{ ...backward, kind: "contradicts", computed_at: T0 }],
      updated_at: T2,
    });
    expect(findOneSided(byId(a, b), ready("rd_a", "rd_b"))).toEqual([
      { kind: "drop", on: "rd_a", partner: "rd_b" },
      { kind: "drop", on: "rd_b", partner: "rd_a" },
    ]);
  });

  it("purges entries whose partner is missing from the list index", () => {
    const a = manifest("rd_a", { tensions: [forward], tensions_judged: [judgedA, { id: "rd_c", judged_at: T1 }] });
    const c = manifest("rd_c");
    expect(findOneSided(byId(a, c), ready("rd_a", "rd_c"))).toEqual([
      { kind: "drop", on: "rd_a", partner: "rd_b", dangling: true },
      { kind: "mirror-judged", from: "rd_a", to: "rd_c", judged_at: T1 },
    ]);
  });

  it("purges entries whose partner is present but not ready", () => {
    const a = manifest("rd_a", { tensions: [forward], tensions_judged: [judgedA] });
    const b = manifest("rd_b", { status: "failed", tensions: [backward], tensions_judged: [judgedB] });
    expect(findOneSided(byId(a, b), ready("rd_a"))).toEqual([
      { kind: "drop", on: "rd_a", partner: "rd_b", dangling: true },
    ]);
    const judgedOnly = manifest("rd_a", { tensions_judged: [{ id: "rd_gone", judged_at: T1 }] });
    expect(findOneSided(byId(judgedOnly), ready("rd_a"))).toEqual([
      { kind: "drop", on: "rd_a", partner: "rd_gone", dangling: true },
    ]);
  });

  it("skips a ready partner that was not loaded, and a holder that is not ready", () => {
    const a = manifest("rd_a", { tensions: [forward], tensions_judged: [judgedA] });
    expect(findOneSided(byId(a), ready("rd_a", "rd_b"))).toEqual([]);
    expect(findOneSided(byId(a), ready("rd_b"))).toEqual([]);
  });

  it("does not mirror a judged record onto a partner rewritten since", () => {
    const a = manifest("rd_a", { tensions_judged: [judgedA] });
    const b = manifest("rd_b", { updated_at: T2 });
    expect(findOneSided(byId(a, b), ready("rd_a", "rd_b"))).toEqual([]);
  });
});

describe("purgeTensionPartner", () => {
  it("removes the partner's entry and judged record and preserves everything else", () => {
    const other = { id: "rd_c", kind: "contradicts", reason: "keep", computed_at: T0 };
    const before = manifest("rd_a", {
      connections: [{ id: "rd_gone", reason: "still cited" }],
      tensions: [{ id: "rd_gone", kind: "supersedes", reason: "old", computed_at: T0 }, other],
      tensions_judged: [{ id: "rd_gone", judged_at: T0 }, { id: "rd_c", judged_at: T0 }],
    });
    const out = purgeTensionPartner(before, "rd_gone");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest.tensions).toEqual([other]);
    expect(out.manifest.tensions_judged).toEqual([{ id: "rd_c", judged_at: T0 }]);
    const { tensions: _t, tensions_judged: _j, ...rest } = out.manifest;
    const { tensions: _bt, tensions_judged: _bj, ...beforeRest } = before;
    expect(rest).toEqual(beforeRest);
    expect(out.manifest.connections).toBe(before.connections);
    expect(out.manifest.updated_at).toBe(T0);
    expect(JSON.stringify(Object.keys(out.manifest))).toBe(JSON.stringify(Object.keys(before)));
  });

  it("leaves a manifest without the fields untouched and fails closed on a non-object", () => {
    const before = manifest("rd_a");
    const out = purgeTensionPartner(before, "rd_gone");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.manifest).toEqual(before);
    expect(purgeTensionPartner(null, "rd_gone")).toMatchObject({ ok: false });
  });
});

describe("buildTensionJudgementInput", () => {
  it("uses stored summary fields and labels the sides", () => {
    const input = buildTensionJudgementInput(manifest("rd_a"), manifest("rd_b", { summary_markdown: undefined }));
    expect(input.a).toEqual({
      id: "rd_a",
      url: "https://example.com/rd_a",
      title: "Title rd_a",
      tldr: "Summary rd_a",
      summary_markdown: "Stored summary rd_a.",
      created_at: T0,
    });
    expect(input.b.summary_markdown).toBe("Summary rd_b");
  });

  it("refuses a reading without summary text", () => {
    expect(() =>
      buildTensionJudgementInput(manifest("rd_a"), manifest("rd_b", { summary_markdown: " ", tldr: "" })),
    ).toThrow(/rd_b has no stored summary text/);
  });
});
