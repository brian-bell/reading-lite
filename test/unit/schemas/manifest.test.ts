import { describe, expect, it } from "vitest";
import {
  ManifestSchema,
  EmitReadingToolInputSchema,
  ByUrlPointerSchema,
  ProcessingAttemptSchema,
  type Manifest,
} from "../../../src/schemas/manifest";

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
    keywords: ["b"],
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

  it("requires all enrichment arrays even if empty", () => {
    const { tags: _tags, ...without } = valid;
    void _tags;
    expect(() => EmitReadingToolInputSchema.parse(without)).toThrow();
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
