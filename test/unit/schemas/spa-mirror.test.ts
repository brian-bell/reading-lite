import { describe, expect, it } from "vitest";
import {
  ListIndexItemSchema,
  ListReadingsResponseSchema,
  ListSessionsResponseSchema,
  PostReadingReprocessBodySchema,
} from "../../../src/schemas/api";
import { ManifestSchema } from "../../../src/schemas/manifest";

// The SPA hand-rolls its types in `web/src/types.ts` because it doesn't import
// zod. This file imports those types directly and uses TypeScript's structural
// checking + zod parsing to keep them in lockstep with the worker schemas.
//
// Drift modes this catches:
//  - SPA field deleted that worker still requires → TS error in the const
//    (the assignment requires the field) AND/OR zod parse error.
//  - SPA field renamed → TS error in the const literal (won't satisfy SPA
//    interface) OR zod parse error if the worker still requires the old name.
//  - SPA field re-typed wrong → TS error in the const.
//
// Drift modes this does NOT catch (worker-only): worker adds a new optional
// field that the SPA doesn't model. That's tolerable — extras are stripped on
// the wire and the SPA simply ignores them.
import type {
  Manifest as SpaManifest,
  ListReading as SpaListReading,
  ListReadingsResponse as SpaListReadingsResponse,
  ListSessionsResponse as SpaListSessionsResponse,
  ReprocessReadingBody as SpaReprocessReadingBody,
  Usage as SpaUsage,
} from "../../../web/src/types";

describe("SPA type mirror — Manifest", () => {
  it("an instance shaped per SpaManifest parses through ManifestSchema", () => {
    const m: SpaManifest = {
      id: "rd_X",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      status: "ready",
      title: "T",
      tldr: "L",
      tags: ["t"],
      keywords: [],
      people: [],
      orgs: [],
      novelty_verdict: "novel",
      connections: [],
      summary_markdown: "s",
      content_type: "text/html",
      content_status: "captured",
      content_bytes: 1,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("a failed SpaManifest with error block parses", () => {
    const m: SpaManifest = {
      id: "rd_X",
      url: "https://example.com/a",
      url_hash: "a".repeat(64),
      status: "failed",
      error: { code: "BadStatusError", message: "404" },
      content_type: "application/octet-stream",
      content_status: "failed",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    };
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("SPA usage accepts legacy and both V2 provider shapes", () => {
    const usages: SpaUsage[] = [
      {
        anthropic_input_tokens: 10,
        anthropic_output_tokens: 5,
        openai_embedding_tokens: 3,
      },
      {
        summarization: {
          provider: "openai",
          model: "gpt-5.6-terra",
          input_tokens: 10,
          output_tokens: 5,
          reasoning_tokens: 2,
          cached_input_tokens: 1,
          cache_write_tokens: 0,
        },
        openai_embedding_tokens: 3,
      },
      {
        summarization: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 1,
        },
        openai_embedding_tokens: 3,
      },
    ];

    for (const usage of usages) {
      expect(() => ManifestSchema.parse({ ...mWithUsageBase, usage })).not.toThrow();
    }
  });
});

const mWithUsageBase: SpaManifest = {
  id: "rd_USAGE",
  url: "https://example.com/usage",
  url_hash: "a".repeat(64),
  status: "ready",
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 1,
  content_sha256: "0".repeat(64),
  created_at: "2026-04-26T20:00:00.000Z",
  updated_at: "2026-04-26T20:00:00.000Z",
};

describe("SPA type mirror — ListReadingsResponse", () => {
  it("an instance shaped per SpaListReadingsResponse parses through the response schema", () => {
    const r: SpaListReadingsResponse = {
      readings: [
        {
          id: "rd_X",
          key_prefix: "readings/2026/04/26T200000Z-rd_X",
          url: "https://example.com/a",
          status: "ready",
          title: "T",
          tldr: "L",
          tags: ["t"],
          keywords: ["soft skills"],
          novelty_verdict: "novel",
          created_at: "2026-04-26T20:00:00.000Z",
          updated_at: "2026-04-26T20:00:00.000Z",
        },
      ],
      limit: 20,
      offset: 0,
      has_more: false,
    };
    expect(() => ListReadingsResponseSchema.parse(r)).not.toThrow();
  });

  it("a ListReading instance parses as a ListIndexItem (wire-shape contract)", () => {
    const item: SpaListReading = {
      id: "rd_X",
      key_prefix: "readings/2026/04/26T200000Z-rd_X",
      url: "https://example.com/a",
      title: "T",
      tldr: "L",
      tags: ["t"],
      keywords: ["soft skills"],
      status: "ready",
      novelty_verdict: "novel",
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    };
    expect(() => ListIndexItemSchema.parse(item)).not.toThrow();
  });
});

describe("SPA type mirror — ReprocessReadingBody", () => {
  it("the SPA's own empty body still parses (back-compat)", () => {
    const body: SpaReprocessReadingBody = {};
    expect(PostReadingReprocessBodySchema.parse(body)).toEqual({ force: false });
  });

  it("a body carrying a markdown source parses through the worker schema", () => {
    const body: SpaReprocessReadingBody = {
      force: true,
      email: false,
      source: { kind: "markdown", markdown: "# Recaptured", title: "Recaptured" },
    };
    expect(PostReadingReprocessBodySchema.parse(body)).toEqual(body);
  });
});

describe("SPA type mirror — ListSessionsResponse", () => {
  it("an instance shaped per SpaListSessionsResponse parses through ListSessionsResponseSchema", () => {
    const body: SpaListSessionsResponse = {
      sessions: [
        {
          id: "ses_550e8400-e29b-41d4-a716-446655440000",
          current: true,
          created_at_ms: 1,
          authenticated_at_ms: 1,
          last_seen_at_ms: 1,
          idle_expires_at_ms: 2,
          absolute_expires_at_ms: 3,
          revoked_at_ms: null,
          revocation_reason: null,
          user_agent_label: "test",
          usable: true,
        },
      ],
      session_cap_warning: "at cap",
    };
    expect(() => ListSessionsResponseSchema.parse(body)).not.toThrow();
  });
});
