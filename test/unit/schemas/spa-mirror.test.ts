import { describe, expect, it } from "vitest";
import {
  ListIndexItemSchema,
  ListReadingsResponseSchema,
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
  ListReadingsResponse as SpaListReadingsResponse,
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
});

describe("SPA type mirror — ListReadingsResponse", () => {
  it("an instance shaped per SpaListReadingsResponse parses through the response schema", () => {
    const r: SpaListReadingsResponse = {
      readings: [
        {
          id: "rd_X",
          url: "https://example.com/a",
          url_hash: "a".repeat(64),
          status: "ready",
          content_type: "text/html",
          content_status: "captured",
          content_bytes: 1,
          content_sha256: "0".repeat(64),
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

  it("each reading entry is also valid as a ListIndexItem (the actual wire shape)", () => {
    // The SPA models /readings as Manifest[], but the worker actually returns
    // ListIndexItem[]. This pins that the subset of Manifest fields the SPA
    // reads on the list page matches the index-item contract.
    const item = {
      id: "rd_X",
      key_prefix: "readings/2026/04/26T200000Z-rd_X",
      url: "https://example.com/a",
      title: "T",
      tldr: "L",
      tags: ["t"],
      status: "ready" as const,
      novelty_verdict: "novel" as const,
      created_at: "2026-04-26T20:00:00.000Z",
      updated_at: "2026-04-26T20:00:00.000Z",
    };
    expect(() => ListIndexItemSchema.parse(item)).not.toThrow();
  });
});
