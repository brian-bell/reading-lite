import { describe, expect, it } from "vitest";
import {
  PostReadingsBodySchema,
  PostReadingsSimilarBodySchema,
  ListReadingsQuerySchema,
  ListReadingsResponseSchema,
  ListIndexItemSchema,
  ListIndexSchema,
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
    });
    expect(parsed.tags).toEqual(["ai", "infra"]);
    expect(parsed.novelty_verdict).toBe("novel");
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
