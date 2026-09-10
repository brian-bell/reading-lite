import { describe, expect, it } from "vitest";
import {
  ManifestSchema,
  EmitReadingToolInputSchema,
  ByUrlPointerSchema,
  ProcessingAttemptSchema,
  type Manifest,
} from "../../../src/schemas/manifest";
import {
  READING_SUMMARY_JSON_SCHEMA,
  RELATIONSHIP_JUDGEMENT_JSON_SCHEMA,
  RelationshipJudgementSchema,
  TENSION_JUDGEMENT_JSON_SCHEMA,
  TensionJudgementSchema,
  TensionKindSchema,
  TensionSchema,
} from "../../../src/schemas/reading-summary";

const baseReady: Manifest = {
  id: "rd_01ABCXYZ",
  url: "https://example.com/a",
  url_hash: "a".repeat(64),
  source_type: "url",
  status: "ready",
  title: "Title",
  tldr: "Short summary.",
  tags: ["t1"],
  keywords: ["k1"],
  people: [],
  orgs: [],
  novelty_verdict: "novel",
  connections: [],
  summary_markdown: "# Title\n\nbody",
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 1234,
  extracted_bytes: 567,
  content_sha256: "b".repeat(64),
  fetched_at: "2026-04-26T20:00:00.000Z",
  created_at: "2026-04-26T20:00:00.000Z",
  updated_at: "2026-04-26T20:00:01.000Z",
  usage: {
    anthropic_input_tokens: 1000,
    anthropic_output_tokens: 200,
    openai_embedding_tokens: 50,
  },
};

describe("ManifestSchema", () => {
  it("accepts a fully populated ready manifest", () => {
    expect(ManifestSchema.parse(baseReady)).toEqual(baseReady);
  });

  it("accepts optional YouTube enrichment_degradation and rejects a bad tier", () => {
    const degradation = {
      source: "youtube" as const,
      tier: "watch_page" as const,
      code: "TooManyRedirectsError",
      message: "redirect chain exceeded 5 hops: https://www.youtube.com/watch",
    };
    expect(
      ManifestSchema.parse({ ...baseReady, enrichment_degradation: degradation }).enrichment_degradation,
    ).toEqual(degradation);
    expect(() =>
      ManifestSchema.parse({
        ...baseReady,
        enrichment_degradation: { ...degradation, tier: "captions" },
      }),
    ).toThrow();
  });

  it("accepts an optional relationship computation time and rejects malformed dates", () => {
    const at = "2026-08-31T12:00:00.000Z";
    expect(
      ManifestSchema.parse({ ...baseReady, connections_computed_at: at })
        .connections_computed_at,
    ).toBe(at);
    expect(() =>
      ManifestSchema.parse({ ...baseReady, connections_computed_at: "yesterday" }),
    ).toThrow();
  });

  it("accepts the optional neighbourhood considered by the latest relationship judgement", () => {
    expect(
      ManifestSchema.parse({
        ...baseReady,
        connections_neighbourhood_ids: ["rd_A", "rd_B"],
      }).connections_neighbourhood_ids,
    ).toEqual(["rd_A", "rd_B"]);
  });

  it("round-trips directional tensions and judged-pair memory", () => {
    const at = "2026-08-31T12:00:00.000Z";
    const tensions = TensionKindSchema.options.map((kind, index) => ({
      id: `rd_${index}`,
      kind,
      reason: `because ${kind}`,
      computed_at: at,
    }));
    const tensions_judged = [{ id: "rd_none", judged_at: at }];
    const parsed = ManifestSchema.parse({ ...baseReady, tensions, tensions_judged });
    expect(parsed.tensions).toEqual(tensions);
    expect(parsed.tensions_judged).toEqual(tensions_judged);
    expect(ManifestSchema.parse(baseReady).tensions).toBeUndefined();
    expect(ManifestSchema.parse(baseReady).tensions_judged).toBeUndefined();
  });

  it("rejects malformed tensions", () => {
    const at = "2026-08-31T12:00:00.000Z";
    const good = { id: "rd_b", kind: "contradicts", reason: "r", computed_at: at };
    for (const bad of [
      { ...good, kind: "agrees" },
      { ...good, reason: "" },
      { ...good, id: "" },
      { ...good, computed_at: "yesterday" },
      { ...good, extra: true },
      { id: "rd_b", kind: "contradicts", reason: "r" },
    ]) {
      expect(() => ManifestSchema.parse({ ...baseReady, tensions: [bad] })).toThrow();
      expect(() => TensionSchema.parse(bad)).toThrow();
    }
    expect(() =>
      ManifestSchema.parse({ ...baseReady, tensions_judged: [{ id: "rd_b" }] }),
    ).toThrow();
    expect(() =>
      ManifestSchema.parse({
        ...baseReady,
        tensions_judged: [{ id: "rd_b", judged_at: at, kind: "contradicts" }],
      }),
    ).toThrow();
  });

  it("accepts OpenAI V2 usage on a ready manifest", () => {
    const usage = {
      summarization: {
        provider: "openai" as const,
        model: "gpt-5.6-terra",
        input_tokens: 1_000,
        output_tokens: 200,
        reasoning_tokens: 75,
        cached_input_tokens: 50,
        cache_write_tokens: 25,
      },
      openai_embedding_tokens: 50,
    };

    expect(ManifestSchema.parse({ ...baseReady, usage }).usage).toEqual(usage);
  });

  it("accepts Anthropic V2 usage on a ready manifest", () => {
    const usage = {
      summarization: {
        provider: "anthropic" as const,
        model: "claude-sonnet-4-6",
        input_tokens: 1_000,
        output_tokens: 200,
        cache_creation_input_tokens: 80,
        cache_read_input_tokens: 640,
      },
      openai_embedding_tokens: 50,
    };

    expect(ManifestSchema.parse({ ...baseReady, usage }).usage).toEqual(usage);
  });

  it("accepts a pending manifest with no enriched fields", () => {
    const pending: Manifest = {
      id: "rd_01ABCXYZ",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    };
    expect(ManifestSchema.parse(pending)).toEqual(pending);
  });

  it("accepts a failed manifest with an error", () => {
    const failed: Manifest = {
      id: "rd_01ABCXYZ",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      status: "failed",
      error: { code: "fetch_failed", message: "connection refused" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    };
    expect(ManifestSchema.parse(failed)).toEqual(failed);
  });

  it("accepts processing attempt summaries on a manifest", () => {
    const withAttempts: Manifest = {
      ...baseReady,
      active_attempt: {
        id: "at_1",
        trigger: "reprocess",
        status: "running",
        stage: "fetch_source",
        started_at: "2026-04-26T20:00:05.000Z",
      },
      last_attempt: {
        id: "at_0",
        trigger: "submit",
        status: "succeeded",
        stage: "write_indexes",
        started_at: "2026-04-26T20:00:00.000Z",
        finished_at: "2026-04-26T20:00:04.000Z",
      },
    };
    expect(ManifestSchema.parse(withAttempts)).toEqual(withAttempts);
  });

  it("rejects unknown status", () => {
    expect(() => ManifestSchema.parse({ ...baseReady, status: "in_progress" })).toThrow();
  });

  it("rejects unknown content_status", () => {
    expect(() => ManifestSchema.parse({ ...baseReady, content_status: "weird" })).toThrow();
  });

  it("rejects an invalid url", () => {
    expect(() => ManifestSchema.parse({ ...baseReady, url: "not a url" })).toThrow();
  });

  it("rejects negative content_bytes", () => {
    expect(() => ManifestSchema.parse({ ...baseReady, content_bytes: -1 })).toThrow();
  });

  it("rejects malformed url_hash (must be 64 lowercase hex)", () => {
    expect(() => ManifestSchema.parse({ ...baseReady, url_hash: "abc" })).toThrow();
    expect(() => ManifestSchema.parse({ ...baseReady, url_hash: "G".repeat(64) })).toThrow();
  });

  it("rejects malformed content_sha256", () => {
    expect(() => ManifestSchema.parse({ ...baseReady, content_sha256: "abc" })).toThrow();
  });

  it("strips unknown top-level keys", () => {
    const parsed = ManifestSchema.parse({ ...baseReady, surprise: "no" } as unknown);
    expect((parsed as Record<string, unknown>).surprise).toBeUndefined();
  });
});

describe("ProcessingAttemptSchema", () => {
  it("accepts a failed attempt with staged events", () => {
    const attempt = {
      id: "at_1",
      trigger: "submit",
      status: "failed",
      stage: "summarize",
      started_at: "2026-04-26T20:00:00.000Z",
      finished_at: "2026-04-26T20:00:05.000Z",
      reading_id: "rd_1",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      key_prefix: "readings/2026/04/26T200000Z-rd_1",
      error: {
        code: "AnthropicError",
        message: "rate limited",
        stage: "summarize",
        failed_at: "2026-04-26T20:00:05.000Z",
        retryable: true,
      },
      events: [
        { stage: "queued", status: "started", at: "2026-04-26T20:00:00.000Z" },
        { stage: "summarize", status: "started", at: "2026-04-26T20:00:01.000Z" },
        {
          stage: "summarize",
          status: "failed",
          at: "2026-04-26T20:00:05.000Z",
          duration_ms: 4000,
          error: {
            code: "AnthropicError",
            message: "rate limited",
            stage: "summarize",
            failed_at: "2026-04-26T20:00:05.000Z",
            retryable: true,
          },
        },
      ],
    };
    expect(ProcessingAttemptSchema.parse(attempt)).toEqual(attempt);
  });

  it("accepts an import attempt with prepare_markdown events", () => {
    const attempt = {
      id: "at_import",
      trigger: "import",
      status: "succeeded",
      stage: "write_indexes",
      started_at: "2026-04-26T20:00:00.000Z",
      finished_at: "2026-04-26T20:00:05.000Z",
      reading_id: "rd_1",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      key_prefix: "readings/2026/04/26T200000Z-rd_1",
      events: [
        { stage: "queued", status: "started", at: "2026-04-26T20:00:00.000Z" },
        { stage: "prepare_markdown", status: "started", at: "2026-04-26T20:00:01.000Z" },
        { stage: "prepare_markdown", status: "succeeded", at: "2026-04-26T20:00:01.000Z" },
      ],
    };
    expect(ProcessingAttemptSchema.parse(attempt)).toEqual(attempt);
  });
});

describe("EmitReadingToolInputSchema", () => {
  const valid = {
    title: "T",
    tldr: "summary",
    tags: ["a"],
    keywords: ["one", "two", "three"],
    people: [],
    orgs: [],
    novelty_verdict: "familiar" as const,
    connections: [{ id: "rd_01XYZ", reason: "same topic" }],
    summary_markdown: "body",
  };

  it("accepts a valid tool input", () => {
    expect(EmitReadingToolInputSchema.parse(valid)).toEqual(valid);
  });

  it("rejects unknown novelty_verdict", () => {
    expect(() => EmitReadingToolInputSchema.parse({ ...valid, novelty_verdict: "maybe" })).toThrow();
  });

  it("rejects empty title", () => {
    expect(() => EmitReadingToolInputSchema.parse({ ...valid, title: "" })).toThrow();
  });

  it("rejects titles longer than 120 characters", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({ ...valid, title: "x".repeat(121) }),
    ).toThrow();
  });

  it("rejects empty tldr", () => {
    expect(() => EmitReadingToolInputSchema.parse({ ...valid, tldr: "" })).toThrow();
  });

  it("rejects connection with empty id", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({
        ...valid,
        connections: [{ id: "", reason: "x" }],
      }),
    ).toThrow();
  });

  it("requires at least one tag", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({ ...valid, tags: [] }),
    ).toThrow();
  });

  it("accepts no more than six tags", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({
        ...valid,
        tags: ["one", "two", "three", "four", "five", "six", "seven"],
      }),
    ).toThrow();
  });

  it("requires at least three keywords", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({ ...valid, keywords: ["one", "two"] }),
    ).toThrow();
  });

  it("accepts no more than fifteen keywords", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({
        ...valid,
        keywords: Array.from({ length: 16 }, (_, index) => `keyword-${index}`),
      }),
    ).toThrow();
  });

  it("requires all enrichment arrays even if empty", () => {
    const { tags: _tags, ...without } = valid;
    void _tags;
    expect(() => EmitReadingToolInputSchema.parse(without)).toThrow();
  });

  it("rejects tensions from the ingest summarizer contract", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({ ...valid, tensions: [] }),
    ).toThrow();
    expect(() =>
      EmitReadingToolInputSchema.parse({ ...valid, tensions_judged: [] }),
    ).toThrow();
    expect(Object.keys(READING_SUMMARY_JSON_SCHEMA.properties)).not.toContain("tensions");
    expect(Object.keys(RELATIONSHIP_JUDGEMENT_JSON_SCHEMA.properties)).not.toContain(
      "tensions",
    );
    expect(() =>
      RelationshipJudgementSchema.parse({
        novelty_verdict: "novel",
        connections: [],
        tensions: [],
      }),
    ).toThrow();
  });

  it("rejects unknown summary and connection fields", () => {
    expect(() =>
      EmitReadingToolInputSchema.parse({ ...valid, unexpected: true }),
    ).toThrow();
    expect(() =>
      EmitReadingToolInputSchema.parse({
        ...valid,
        connections: [{ id: "rd_01XYZ", reason: "same topic", unexpected: true }],
      }),
    ).toThrow();
  });
});

describe("READING_SUMMARY_JSON_SCHEMA", () => {
  it("requires the strict nine-field reading contract", () => {
    expect(READING_SUMMARY_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "tldr",
        "tags",
        "keywords",
        "people",
        "orgs",
        "novelty_verdict",
        "connections",
        "summary_markdown",
      ],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        tags: { type: "array", minItems: 1, maxItems: 6 },
        keywords: { type: "array", minItems: 3, maxItems: 15 },
        connections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "reason"],
          },
        },
      },
    });
  });
});

describe("RelationshipJudgementSchema", () => {
  it("accepts only novelty and connections", () => {
    const value = {
      novelty_verdict: "familiar",
      connections: [{ id: "rd_B", reason: "same finding" }],
    };
    expect(RelationshipJudgementSchema.parse(value)).toEqual(value);
    expect(() =>
      RelationshipJudgementSchema.parse({ ...value, title: "must not change" }),
    ).toThrow();
    expect(RELATIONSHIP_JUDGEMENT_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ["novelty_verdict", "connections"],
    });
  });
});

describe("ByUrlPointerSchema", () => {
  it("accepts a valid pointer", () => {
    const p = { id: "rd_01ABC", key_prefix: "readings/2026/04/26T200000Z-rd_01ABC" };
    expect(ByUrlPointerSchema.parse(p)).toEqual(p);
  });

  it("rejects empty id", () => {
    expect(() => ByUrlPointerSchema.parse({ id: "", key_prefix: "x" })).toThrow();
  });

  it("rejects empty key_prefix", () => {
    expect(() => ByUrlPointerSchema.parse({ id: "rd_x", key_prefix: "" })).toThrow();
  });
});

describe("TensionJudgementSchema", () => {
  it("accepts every verdict shape the judge may return", () => {
    for (const judgement of [
      { verdict: "none", side: null, reason: "" },
      { verdict: "contradicts", side: null, reason: "opposing claims" },
      { verdict: "supersedes", side: "a", reason: "newer result" },
      { verdict: "supersedes", side: "b", reason: "newer result" },
      { verdict: "qualifies", side: "a", reason: "narrower scope" },
      { verdict: "qualifies", side: "b", reason: "narrower scope" },
    ]) {
      expect(TensionJudgementSchema.parse(judgement)).toEqual(judgement);
    }
  });

  it("rejects a side on symmetric verdicts, a missing side on directional ones, and empty reasons", () => {
    for (const bad of [
      { verdict: "none", side: "a", reason: "" },
      { verdict: "contradicts", side: "b", reason: "r" },
      { verdict: "supersedes", side: null, reason: "r" },
      { verdict: "qualifies", side: null, reason: "r" },
      { verdict: "contradicts", side: null, reason: "  " },
      { verdict: "agrees", side: null, reason: "r" },
      { verdict: "none", side: null, reason: "", extra: 1 },
      { verdict: "none", reason: "" },
    ]) {
      expect(() => TensionJudgementSchema.parse(bad)).toThrow();
    }
  });

  it("keeps the strict JSON schema aligned with the zod contract", () => {
    expect(TENSION_JUDGEMENT_JSON_SCHEMA.required).toEqual(["verdict", "side", "reason"]);
    expect(TENSION_JUDGEMENT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(TENSION_JUDGEMENT_JSON_SCHEMA.properties.verdict.enum).toEqual([
      "none",
      "contradicts",
      "supersedes",
      "qualifies",
    ]);
    expect(TENSION_JUDGEMENT_JSON_SCHEMA.properties.side.enum).toEqual(["a", "b", null]);
  });
});
