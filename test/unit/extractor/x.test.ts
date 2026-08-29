import { describe, expect, it, vi } from "vitest";
import { extractXThread, parseXPostId } from "../../../src/modules/extractor/x";
import {
  XThreadIncompleteError,
  XThreadOutsideRecentWindowError,
} from "../../../src/modules/extractor/errors";

describe("parseXPostId", () => {
  it("extracts a status id while ignoring share parameters", () => {
    expect(
      parseXPostId("https://x.com/distributionat/status/2081655420314419450?s=46"),
    ).toBe("2081655420314419450");
    expect(parseXPostId("https://mobile.twitter.com/i/status/123456789#fragment")).toBe(
      "123456789",
    );
  });

  it("accepts common permalink variants", () => {
    expect(parseXPostId("https://twitter.com/i/web/status/123456789")).toBe("123456789");
    expect(parseXPostId("https://x.com/i/web/status/123456789")).toBe("123456789");
    expect(parseXPostId("https://x.com/someone/status/123456789/photo/1")).toBe("123456789");
    expect(parseXPostId("https://twitter.com/someone/status/123456789/video/2")).toBe(
      "123456789",
    );
    expect(parseXPostId("https://www.x.com/someone/status/123456789")).toBe("123456789");
    expect(parseXPostId("https://mobile.x.com/someone/status/123456789")).toBe("123456789");
  });

  it("rejects non-status paths and lookalike hosts", () => {
    expect(parseXPostId("https://x.com/distributionat")).toBeNull();
    expect(parseXPostId("https://x.com/distributionat/status/not-a-number")).toBeNull();
    expect(parseXPostId("https://x.com.evil.example/user/status/123")).toBeNull();
    expect(parseXPostId("https://example.com/user/status/123")).toBeNull();
    expect(parseXPostId("https://x.com/someone/status/123/analytics")).toBeNull();
    expect(parseXPostId("https://x.com/someone/status/123/photo/x")).toBeNull();
  });
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const xDeps = {
  bearerToken: "test-x-token",
  timeoutMs: 5_000,
  maxBytes: 1_000_000,
  now: () => Date.parse("2026-07-28T12:00:00Z"),
};

describe("extractXThread", () => {
  it("renders the complete same-author component around a shared middle post", async () => {
    const root = {
      id: "100",
      text: "Root post",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const shared = {
      id: "200",
      text: "Shared middle",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:01:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const child = {
      id: "300",
      text: "Author descendant",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:02:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "200" }],
    };
    const audience = {
      id: "400",
      text: "Audience reply",
      author_id: "audience-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:03:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "200" }],
    };
    const sideReply = {
      id: "500",
      text: "Author side conversation",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:04:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "400" }],
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-x-token" });
      if (url.pathname === "/2/tweets/200") {
        return json({
          data: shared,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
            tweets: [root],
          },
        });
      }
      if (url.pathname === "/2/tweets/100") return json({ data: root });
      if (url.pathname === "/2/tweets/search/recent") {
        expect(url.searchParams.get("query")).toBe(
          "conversation_id:100 from:author -is:retweet",
        );
        expect(url.searchParams.get("max_results")).toBe("100");
        expect(url.searchParams.has("start_time")).toBe(false);
        return json({
          data: [root, shared, child, audience, sideReply],
          includes: {
            users: [
              { id: "author-1", name: "Author Name", username: "author" },
              { id: "audience-1", name: "Audience", username: "audience" },
            ],
            tweets: [audience],
          },
          meta: {},
        });
      }
      return json({ title: "unexpected request" }, 500);
    });

    const out = await extractXThread("https://x.com/author/status/200?s=46", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.title).toBe("X thread by Author Name (@author)");
    expect(out.markdown).toContain("# X thread by Author Name (@author)");
    expect(out.markdown).toContain("Root post");
    expect(out.markdown).toContain("Shared middle");
    expect(out.markdown).toContain("Author descendant");
    expect(out.markdown).not.toContain("Audience reply");
    expect(out.markdown).not.toContain("Author side conversation");
    expect(out.markdown!.indexOf("Root post")).toBeLessThan(
      out.markdown!.indexOf("Shared middle"),
    );
    expect(out.markdown!.indexOf("Shared middle")).toBeLessThan(
      out.markdown!.indexOf("Author descendant"),
    );
    expect(out.content_type).toBe("application/json; charset=utf-8");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("fails visibly without recent search when the conversation root is older than seven days", async () => {
    const shared = {
      id: "200",
      text: "Shared middle",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-20T12:01:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const root = {
      id: "100",
      text: "Old root",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-20T12:00:00.000Z",
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/200") {
        return json({
          data: shared,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      if (url.pathname === "/2/tweets/100") return json({ data: root });
      return json({ title: "search must not run" }, 500);
    });

    const error = await extractXThread("https://x.com/author/status/200", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(XThreadOutsideRecentWindowError);
    expect((error as Error).message).toBe(
      "This X thread is older than the 7-day recent-search window and cannot be imported.",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("maps a partial primary-post response to an incomplete-thread error", async () => {
    const fetchFn = vi.fn(async () =>
      json({
        errors: [
          {
            title: "Not Found Error",
            detail: "Could not find tweet with id: [200].",
            type: "https://api.x.com/2/problems/resource-not-found",
          },
        ],
      }),
    );

    await expect(
      extractXThread("https://x.com/author/status/200", {
        ...xDeps,
        fetch: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(XThreadIncompleteError);
  });

  it("fails instead of returning a partial thread when a required same-author parent is missing", async () => {
    const root = {
      id: "100",
      text: "Root post",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const missingParent = {
      id: "200",
      text: "Missing parent",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:01:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const shared = {
      id: "300",
      text: "Shared leaf",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:02:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "200" }],
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/300") {
        return json({
          data: shared,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
            tweets: [missingParent],
          },
        });
      }
      if (url.pathname === "/2/tweets/100") return json({ data: root });
      if (url.pathname === "/2/tweets/search/recent") {
        return json({ data: [root, shared], meta: {} });
      }
      return json({}, 500);
    });

    await expect(
      extractXThread("https://x.com/author/status/300", {
        ...xDeps,
        fetch: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(XThreadIncompleteError);
  });

  it("fails on partial API errors that are not limited to an unavailable quote", async () => {
    const root = {
      id: "100",
      text: "Root post",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: root,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      return json({
        data: [root],
        errors: [{ value: "missing-primary-post", detail: "A post was unavailable." }],
        meta: {},
      });
    });

    await expect(
      extractXThread("https://x.com/author/status/100", {
        ...xDeps,
        fetch: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(XThreadIncompleteError);
  });

  it("imports when a quoted author expansion fails", async () => {
    const quoted = {
      id: "99",
      text: "Quoted body",
      author_id: "suspended-user",
      conversation_id: "99",
      created_at: "2026-07-26T12:00:00.000Z",
    };
    const shared = {
      id: "100",
      text: "I quote a deleted account",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
      referenced_tweets: [{ type: "quoted", id: "99" }],
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: shared,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
            tweets: [quoted],
          },
          errors: [
            {
              value: "suspended-user",
              parameter: "referenced_tweets.id.author_id",
              title: "Not Found Error",
              detail: "Could not find user with ids: [suspended-user].",
            },
          ],
        });
      }
      return json({ data: [shared], meta: {} });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain("I quote a deleted account");
    expect(out.markdown).toContain("Quoted post unavailable: https://x.com/i/status/99");
    expect(out.markdown).not.toContain("Quoted body");
  });

  it("imports when media hydration fails and honors resource_id without value", async () => {
    const shared = {
      id: "100",
      text: "A post with a missing image",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
      attachments: { media_keys: ["3_missing"] },
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: shared,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
          errors: [
            {
              resource_id: "3_missing",
              title: "Not Found Error",
              detail: "Could not find media with keys: [3_missing].",
            },
          ],
        });
      }
      return json({ data: [shared], meta: {} });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain("A post with a missing image");
    expect(out.markdown).not.toContain("![");
    expect(out.markdown).not.toContain("3_missing");
  });

  it("does not treat lookup vs search optional nested key differences as a conflict", async () => {
    const lookupPost = {
      id: "100",
      text: "Hello from lookup",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
      note_tweet: {
        text: "Hello from lookup",
        entities: {
          urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/a" }],
        },
      },
      article: { title: "Extra", preview_text: "Hello from lookup", source: { id: "art-1" } },
      attachments: { media_keys: ["media-1"], poll_ids: ["poll-1"] },
      referenced_tweets: [{ type: "quoted" as const, id: "99", extra: "passthrough" }],
    };
    const searchPost = {
      id: "100",
      text: "Hello from lookup",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
      note_tweet: {
        entities: {
          urls: [{ expanded_url: "https://example.com/a", url: "https://t.co/a" }],
        },
        text: "Hello from lookup",
      },
      attachments: { poll_ids: ["poll-1"], media_keys: ["media-1"] },
      referenced_tweets: [{ extra: "passthrough", id: "99", type: "quoted" as const }],
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: lookupPost,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      return json({ data: [searchPost], meta: {} });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain("Hello from lookup");
    expect(out.markdown).toContain("## Extra");
  });

  it("keeps lookup long-form, article, and expanded urls when search is truncated", async () => {
    const lookupPost = {
      id: "100",
      text: "truncated https://t.co/link",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
      note_tweet: {
        text: "Full long-form body https://t.co/link",
        entities: {
          urls: [{ url: "https://t.co/link", expanded_url: "https://example.com/full" }],
        },
      },
      article: {
        title: "Lookup article",
        text: "Article body that search omitted https://t.co/link",
      },
      entities: {
        urls: [{ url: "https://t.co/link", expanded_url: "https://example.com/full" }],
      },
    };
    const searchPost = {
      id: "100",
      text: "truncated https://t.co/link",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: lookupPost,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      return json({ data: [searchPost], meta: {} });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain("## Lookup article");
    expect(out.markdown).toContain("Article body that search omitted https://example.com/full");
    expect(out.markdown).not.toContain("truncated https://t.co/link");
  });

  it("uses search long-form when lookup is the thinner copy", async () => {
    const lookupPost = {
      id: "100",
      text: "truncated https://t.co/link",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const searchPost = {
      ...lookupPost,
      note_tweet: {
        text: "Search recovered the long form https://t.co/link",
        entities: {
          urls: [{ url: "https://t.co/link", expanded_url: "https://example.com/search-copy" }],
        },
      },
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: lookupPost,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      return json({ data: [searchPost], meta: {} });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain(
      "Search recovered the long form https://example.com/search-copy",
    );
    expect(out.markdown).not.toContain("truncated https://t.co/link");
  });

  it("still fails when lookup and search disagree on reconstruction fields", async () => {
    const lookupPost = {
      id: "100",
      text: "Hello from lookup",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const searchPost = {
      ...lookupPost,
      text: "Hello from search",
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: lookupPost,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      return json({ data: [searchPost], meta: {} });
    });

    await expect(
      extractXThread("https://x.com/author/status/100", {
        ...xDeps,
        fetch: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(XThreadIncompleteError);
  });

  it("renders long-form text, expanded links, media, and quoted-post context", async () => {
    const shared = {
      id: "2081655420314419450",
      text: "truncated https://t.co/link",
      note_tweet: {
        text: "Search is broken https://t.co/link",
        entities: {
          urls: [
            {
              url: "https://t.co/link",
              expanded_url: "https://example.com/search",
            },
          ],
        },
      },
      author_id: "author-1",
      conversation_id: "2081655420314419450",
      created_at: "2026-07-27T12:00:00.000Z",
      referenced_tweets: [{ type: "quoted", id: "2081031941898297567" }],
      attachments: { media_keys: ["media-1"] },
    };
    const quoted = {
      id: "2081031941898297567",
      text: "Gmail inbox search is broken.",
      author_id: "author-2",
      conversation_id: "2081031941898297567",
      created_at: "2026-07-26T12:00:00.000Z",
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/2081655420314419450") {
        return json({
          data: shared,
          includes: {
            users: [
              { id: "author-1", name: "Distribution", username: "distributionat" },
              { id: "author-2", name: "James", username: "james406" },
            ],
            tweets: [quoted],
            media: [
              {
                media_key: "media-1",
                type: "photo",
                url: "https://pbs.twimg.com/media/example.jpg",
                alt_text: "Search results screenshot",
              },
            ],
          },
        });
      }
      return json({ data: [shared], meta: {} });
    });

    const out = await extractXThread(
      "https://x.com/distributionat/status/2081655420314419450?s=46",
      { ...xDeps, fetch: fetchFn as unknown as typeof fetch },
    );

    expect(out.title).toBe("X post by Distribution (@distributionat)");
    expect(out.markdown).toContain("Search is broken https://example.com/search");
    expect(out.markdown).not.toContain("truncated https://t.co/link");
    expect(out.markdown).toContain("### Quoted post");
    expect(out.markdown).toContain("James (@james406)");
    expect(out.markdown).toContain("Gmail inbox search is broken.");
    expect(out.markdown).toContain("![Search results screenshot]");
  });

  it("exhausts recent-search pagination and never calls full-archive search", async () => {
    const root = {
      id: "100",
      text: "Page one",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const child = {
      id: "200",
      text: "Page two",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:01:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const requestedPaths: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: root,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      if (!url.searchParams.has("pagination_token")) {
        return json({ data: [root], meta: { next_token: "page-2" } });
      }
      expect(url.searchParams.get("pagination_token")).toBe("page-2");
      return json({ data: [child], meta: {} });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain("Page one");
    expect(out.markdown).toContain("Page two");
    expect(requestedPaths).toEqual([
      "/2/tweets/100",
      "/2/tweets/search/recent",
      "/2/tweets/search/recent",
    ]);
    expect(requestedPaths).not.toContain("/2/tweets/search/all");
  });

  it("imports a just-posted URL without sending a too-new start_time", async () => {
    const shared = {
      id: "100",
      text: "Just posted",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-28T12:00:00.000Z",
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: shared,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
          },
        });
      }
      expect(url.searchParams.has("start_time")).toBe(false);
      return json({ data: [shared], meta: {} });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain("Just posted");
  });

  it("keeps lookup quoted long-form and media urls when search expansions are thinner", async () => {
    const quoted = {
      id: "99",
      text: "truncated quote https://t.co/q",
      note_tweet: {
        text: "Quoted long-form https://t.co/q",
        entities: {
          urls: [{ url: "https://t.co/q", expanded_url: "https://example.com/quoted" }],
        },
      },
      author_id: "author-2",
      conversation_id: "99",
      created_at: "2026-07-26T12:00:00.000Z",
    };
    const thinQuoted = {
      id: "99",
      text: "truncated quote https://t.co/q",
      author_id: "author-2",
      conversation_id: "99",
      created_at: "2026-07-26T12:00:00.000Z",
    };
    const shared = {
      id: "100",
      text: "I quoted them",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
      referenced_tweets: [{ type: "quoted", id: "99" }],
      attachments: { media_keys: ["media-1"] },
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/100") {
        return json({
          data: shared,
          includes: {
            users: [
              { id: "author-1", name: "Author Name", username: "author" },
              { id: "author-2", name: "Quoted Author", username: "quoted" },
            ],
            tweets: [quoted],
            media: [
              {
                media_key: "media-1",
                type: "photo",
                url: "https://pbs.twimg.com/media/full.jpg",
                alt_text: "Lookup photo",
              },
            ],
          },
        });
      }
      return json({
        data: [shared],
        includes: {
          tweets: [thinQuoted],
          media: [{ media_key: "media-1", type: "photo" }],
        },
        meta: {},
      });
    });

    const out = await extractXThread("https://x.com/author/status/100", {
      ...xDeps,
      fetch: fetchFn as unknown as typeof fetch,
    });

    expect(out.markdown).toContain("Quoted long-form https://example.com/quoted");
    expect(out.markdown).not.toContain("truncated quote https://t.co/q");
    expect(out.markdown).toContain("![Lookup photo](https://pbs.twimg.com/media/full.jpg)");
  });

  it("fails when search omits a middle same-author ancestor that expansions returned", async () => {
    const root = {
      id: "100",
      text: "Root post",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:00:00.000Z",
    };
    const omittedMiddle = {
      id: "200",
      text: "Omitted middle",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:01:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "100" }],
    };
    const parent = {
      id: "300",
      text: "Present parent",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:02:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "200" }],
    };
    const shared = {
      id: "400",
      text: "Shared leaf",
      author_id: "author-1",
      conversation_id: "100",
      created_at: "2026-07-27T12:03:00.000Z",
      referenced_tweets: [{ type: "replied_to", id: "300" }],
    };
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/tweets/400") {
        return json({
          data: shared,
          includes: {
            users: [{ id: "author-1", name: "Author Name", username: "author" }],
            tweets: [parent],
          },
        });
      }
      if (url.pathname === "/2/tweets/100") return json({ data: root });
      if (url.pathname === "/2/tweets/search/recent") {
        return json({
          data: [root, parent, shared],
          includes: { tweets: [omittedMiddle] },
          meta: {},
        });
      }
      return json({}, 500);
    });

    await expect(
      extractXThread("https://x.com/author/status/400", {
        ...xDeps,
        fetch: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(XThreadIncompleteError);
  });
});
