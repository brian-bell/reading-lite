import { describe, expect, it } from "vitest";
import {
  PostReadingsBodySchema,
  PostReadingsSimilarBodySchema,
  ListReadingsQuerySchema,
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
  it("defaults limit and accepts no cursor", () => {
    const parsed = ListReadingsQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.cursor).toBeUndefined();
  });

  it("accepts a cursor and a custom limit", () => {
    const parsed = ListReadingsQuerySchema.parse({ cursor: "abc", limit: "50" });
    expect(parsed.cursor).toBe("abc");
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit outside 1..100", () => {
    expect(() => ListReadingsQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => ListReadingsQuerySchema.parse({ limit: "101" })).toThrow();
  });

  it("rejects non-numeric limit", () => {
    expect(() => ListReadingsQuerySchema.parse({ limit: "many" })).toThrow();
  });
});
