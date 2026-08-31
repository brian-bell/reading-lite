import { describe, expect, it } from "vitest";
import {
  PostReadingReprocessBodySchema,
  PostReadingsBodySchema,
  PostReadingsImportMarkdownBodySchema,
  PostReadingsSimilarBodySchema,
  ListReadingsQuerySchema,
  ListReadingsResponseSchema,
  ListIndexItemSchema,
  ListIndexSchema,
  GetWhoamiResponseSchema,
  ListSessionsResponseSchema,
} from "../../../src/schemas/api";

describe("PostReadingsBodySchema", () => {
  it("accepts a valid url", () => {
    expect(PostReadingsBodySchema.parse({ url: "https://example.com/a" })).toEqual({
      url: "https://example.com/a",
    });
  });

  it("rejects a non-http(s) url", () => {
    expect(() => PostReadingsBodySchema.parse({ url: "ftp://example.com/a" })).toThrow();
    expect(() => PostReadingsBodySchema.parse({ url: "file:///etc/passwd" })).toThrow();
  });

  it("rejects an invalid url", () => {
    expect(() => PostReadingsBodySchema.parse({ url: "not a url" })).toThrow();
  });

  it("rejects a missing url", () => {
    expect(() => PostReadingsBodySchema.parse({})).toThrow();
  });
});

describe("PostReadingsImportMarkdownBodySchema", () => {
  it("accepts source_url, markdown, optional title, and optional email", () => {
    expect(
      PostReadingsImportMarkdownBodySchema.parse({
        source_url: "https://example.com/a",
        title: "A",
        markdown: "# A",
        email: false,
      }),
    ).toEqual({
      source_url: "https://example.com/a",
      title: "A",
      markdown: "# A",
      email: false,
    });
  });

  it("rejects non-http source_url and empty markdown", () => {
    expect(() =>
      PostReadingsImportMarkdownBodySchema.parse({
        source_url: "file:///tmp/a.md",
        markdown: "# A",
      }),
    ).toThrow();
    expect(() =>
      PostReadingsImportMarkdownBodySchema.parse({
        source_url: "https://example.com/a",
        markdown: "",
      }),
    ).toThrow();
  });
});

describe("PostReadingReprocessBodySchema", () => {
  it("defaults force=false for an empty body", () => {
    expect(PostReadingReprocessBodySchema.parse({})).toEqual({ force: false });
    expect(PostReadingReprocessBodySchema.parse(undefined)).toEqual({ force: false });
  });

  it("accepts force=true", () => {
    expect(PostReadingReprocessBodySchema.parse({ force: true })).toEqual({ force: true });
  });

  it("accepts an optional markdown source", () => {
    expect(
      PostReadingReprocessBodySchema.parse({
        source: { kind: "markdown", markdown: "# Hi" },
      }),
    ).toEqual({ force: false, source: { kind: "markdown", markdown: "# Hi" } });
  });

  it("accepts a markdown source with a title, alongside force and email", () => {
    expect(
      PostReadingReprocessBodySchema.parse({
        force: true,
        email: true,
        source: { kind: "markdown", markdown: "# Hi", title: "  A Title  " },
      }),
    ).toEqual({
      force: true,
      email: true,
      source: { kind: "markdown", markdown: "# Hi", title: "A Title" },
    });
  });

  it("rejects a non-markdown source kind", () => {
    expect(() =>
      PostReadingReprocessBodySchema.parse({
        source: { kind: "url", url: "https://example.com/a" },
      }),
    ).toThrow();
  });

  it("rejects empty markdown, missing markdown, and an empty title", () => {
    expect(() =>
      PostReadingReprocessBodySchema.parse({ source: { kind: "markdown", markdown: "" } }),
    ).toThrow();
    expect(() =>
      PostReadingReprocessBodySchema.parse({ source: { kind: "markdown" } }),
    ).toThrow();
    expect(() =>
      PostReadingReprocessBodySchema.parse({
        source: { kind: "markdown", markdown: "# Hi", title: "   " },
      }),
    ).toThrow();
  });
});

describe("PostReadingsSimilarBodySchema", () => {
  it("accepts a valid embedding + default k", () => {
    const v = { query_embedding: new Array(1536).fill(0.1) };
    const parsed = PostReadingsSimilarBodySchema.parse(v);
    expect(parsed.query_embedding.length).toBe(1536);
    expect(parsed.k).toBe(10);
  });

  it("respects k when provided", () => {
    const v = { query_embedding: new Array(1536).fill(0), k: 5 };
    expect(PostReadingsSimilarBodySchema.parse(v).k).toBe(5);
  });

  it("rejects wrong embedding dimension", () => {
    expect(() =>
      PostReadingsSimilarBodySchema.parse({ query_embedding: new Array(768).fill(0) }),
    ).toThrow();
  });

  it("rejects k outside 1..50", () => {
    const e = new Array(1536).fill(0);
    expect(() => PostReadingsSimilarBodySchema.parse({ query_embedding: e, k: 0 })).toThrow();
    expect(() => PostReadingsSimilarBodySchema.parse({ query_embedding: e, k: 51 })).toThrow();
  });
});

describe("ListReadingsQuerySchema", () => {
  it("defaults offset=0 and limit=20 with no filters", () => {
    const parsed = ListReadingsQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.offset).toBe(0);
    expect(parsed.q).toBeUndefined();
    expect(parsed.tag).toBeUndefined();
  });

  it("accepts q, tag, offset, limit", () => {
    const parsed = ListReadingsQuerySchema.parse({
      q: "rust",
      tag: "ai",
      offset: "40",
      limit: "10",
    });
    expect(parsed.q).toBe("rust");
    expect(parsed.tag).toBe("ai");
    expect(parsed.offset).toBe(40);
    expect(parsed.limit).toBe(10);
  });

  it("rejects limit outside 1..100", () => {
    expect(() => ListReadingsQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => ListReadingsQuerySchema.parse({ limit: "101" })).toThrow();
  });

  it("rejects non-numeric limit", () => {
    expect(() => ListReadingsQuerySchema.parse({ limit: "many" })).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() => ListReadingsQuerySchema.parse({ offset: "-1" })).toThrow();
  });

  it("rejects non-numeric offset", () => {
    expect(() => ListReadingsQuerySchema.parse({ offset: "abc" })).toThrow();
  });
});

describe("ListReadingsResponseSchema", () => {
  it("requires readings, limit, offset, has_more", () => {
    const valid = {
      readings: [],
      limit: 20,
      offset: 0,
      has_more: false,
    };
    expect(() => ListReadingsResponseSchema.parse(valid)).not.toThrow();
  });

  it("rejects when has_more is missing", () => {
    expect(() =>
      ListReadingsResponseSchema.parse({ readings: [], limit: 20, offset: 0 }),
    ).toThrow();
  });

  it("readings are ListIndexItem-shaped (matches the actual wire response)", () => {
    const valid = {
      readings: [
        {
          id: "rd_X",
          key_prefix: "readings/2026/04/26T200000Z-rd_X",
          url: "https://example.com/a",
          status: "ready",
          title: "T",
          tldr: "L",
          tags: ["t"],
          created_at: "2026-04-26T20:00:00.000Z",
          updated_at: "2026-04-26T20:00:00.000Z",
        },
      ],
      limit: 20,
      offset: 0,
      has_more: false,
    };
    const parsed = ListReadingsResponseSchema.parse(valid);
    expect(parsed.readings[0]!.key_prefix).toBe("readings/2026/04/26T200000Z-rd_X");
  });

  it("rejects readings missing the index-item required key_prefix", () => {
    const invalid = {
      readings: [
        {
          id: "rd_X",
          url: "https://example.com/a",
          status: "ready",
          created_at: "2026-04-26T20:00:00.000Z",
        },
      ],
      limit: 20,
      offset: 0,
      has_more: false,
    };
    expect(() => ListReadingsResponseSchema.parse(invalid)).toThrow();
  });
});

describe("ListIndexItemSchema", () => {
  const baseItem = {
    id: "rd_X",
    key_prefix: "readings/2026/04/26T200000Z-rd_X",
    url: "https://example.com/a",
    status: "ready",
    created_at: "2026-04-26T20:00:00.000Z",
  };

  it("accepts a minimal ready item", () => {
    expect(() => ListIndexItemSchema.parse(baseItem)).not.toThrow();
  });

  it("accepts optional fields", () => {
    const parsed = ListIndexItemSchema.parse({
      ...baseItem,
      title: "Title",
      tldr: "Short",
      tags: ["ai", "infra"],
      novelty_verdict: "novel",
      updated_at: "2026-04-26T20:00:05.000Z",
    });
    expect(parsed.tags).toEqual(["ai", "infra"]);
    expect(parsed.novelty_verdict).toBe("novel");
    expect(parsed.updated_at).toBe("2026-04-26T20:00:05.000Z");
  });

  it("accepts attempt summaries", () => {
    const parsed = ListIndexItemSchema.parse({
      ...baseItem,
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
    });
    expect(parsed.active_attempt?.id).toBe("at_1");
    expect(parsed.last_attempt?.status).toBe("succeeded");
  });

  it("accepts a failed item with error", () => {
    const parsed = ListIndexItemSchema.parse({
      ...baseItem,
      status: "failed",
      error: { code: "BadStatusError", message: "404" },
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.error?.code).toBe("BadStatusError");
  });

  it("accepts a pending item", () => {
    const parsed = ListIndexItemSchema.parse({ ...baseItem, status: "pending" });
    expect(parsed.status).toBe("pending");
  });

  it("rejects an invalid status", () => {
    expect(() =>
      ListIndexItemSchema.parse({ ...baseItem, status: "weird" }),
    ).toThrow();
  });
});

describe("ListIndexSchema", () => {
  it("requires version=1 and items array", () => {
    const valid = { version: 1, items: [] };
    expect(() => ListIndexSchema.parse(valid)).not.toThrow();
  });

  it("rejects an unknown version", () => {
    expect(() => ListIndexSchema.parse({ version: 2, items: [] })).toThrow();
  });
});

describe("GetWhoamiResponseSchema", () => {
  const bearer = {
    tenant_id: "usr_550e8400-e29b-41d4-a716-446655440000",
    user_id: "usr_550e8400-e29b-41d4-a716-446655440000",
    principal: "api_token",
    tenant_data_plane: true,
    email: "founder@test.example",
  };

  it("accepts bearer identity without csrf_token", () => {
    expect(GetWhoamiResponseSchema.parse(bearer)).toEqual(bearer);
  });

  it("accepts a session csrf_token and rejects a malformed one", () => {
    const token = "ab".repeat(32);
    expect(
      GetWhoamiResponseSchema.parse({ ...bearer, principal: "session", csrf_token: token }),
    ).toEqual({ ...bearer, principal: "session", csrf_token: token });
    expect(() =>
      GetWhoamiResponseSchema.parse({ ...bearer, principal: "session", csrf_token: "short" }),
    ).toThrow();
  });
});

describe("ListSessionsResponseSchema", () => {
  it("accepts a current session and a cap warning", () => {
    const body = {
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
        },
      ],
      session_cap_warning: "at cap",
    };
    expect(ListSessionsResponseSchema.parse(body)).toEqual(body);
  });
});
