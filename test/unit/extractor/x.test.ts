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

  it("rejects non-status paths and lookalike hosts", () => {
    expect(parseXPostId("https://x.com/distributionat")).toBeNull();
    expect(parseXPostId("https://x.com/distributionat/status/not-a-number")).toBeNull();
    expect(parseXPostId("https://x.com.evil.example/user/status/123")).toBeNull();
    expect(parseXPostId("https://example.com/user/status/123")).toBeNull();
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
        expect(url.searchParams.get("start_time")).toBe("2026-07-27T12:00:00Z");
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
});
