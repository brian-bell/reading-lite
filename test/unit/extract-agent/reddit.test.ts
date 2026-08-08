import { describe, expect, it, vi } from "vitest";
import { BROWSER_USER_AGENT } from "../../../scripts/corpus-lib/browser-fetch";
import {
  extractReddit,
  redditJsonUrl,
  type RedditDeps,
} from "../../../scripts/extract-agent-lib/reddit";
import { buildRedditImport } from "../../../scripts/reddit-import-lib/parse";
import threadFixture from "../../fixtures/reddit/thread.json";

const THREAD_JSON = JSON.stringify(threadFixture);
const ORIGINAL_URL =
  "https://www.reddit.com/r/programming/comments/1ua2lxq/old_software/?utm_source=share#comments";

function publicLookup(hosts: string[] = []): RedditDeps["lookup"] {
  return async (hostname) => {
    hosts.push(hostname);
    return [{ address: "93.184.216.34" }];
  };
}

function deps(response: Response | (() => Promise<Response> | Response), overrides: Partial<RedditDeps> = {}) {
  const fetch = vi.fn(async () =>
    typeof response === "function" ? response() : response,
  ) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    lookup: publicLookup(),
    maxBytes: 1024 * 1024,
    ...overrides,
  } satisfies RedditDeps;
}

function jsonResponse(body = THREAD_JSON, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

// The query string is load-bearing, not decoration: it is exactly the one the
// manual reddit-import skill fetches. Without `raw_json=1` Reddit HTML-escapes
// entities in title/selftext/body and the recovered markdown lands in the
// corpus as `&gt;`/`&amp;` literals; `limit=20&sort=top` bounds the listing and
// keeps the agent's markdown aligned with a skill import of the same thread.
const JSON_QUERY = "raw_json=1&limit=20&sort=top";

describe("redditJsonUrl", () => {
  it.each([
    [
      "https://www.reddit.com/r/programming/comments/1ua2lxq/old_software/",
      `https://www.reddit.com/r/programming/comments/1ua2lxq/old_software.json?${JSON_QUERY}`,
    ],
    [
      "https://www.reddit.com/r/Xennials/comments/1kelqna/comment/mqk9hr1/",
      `https://www.reddit.com/r/Xennials/comments/1kelqna/comment/mqk9hr1.json?${JSON_QUERY}`,
    ],
    ["https://www.reddit.com/comment/1ua2lxq/", `https://www.reddit.com/comment/1ua2lxq.json?${JSON_QUERY}`],
    ["https://redd.it/1ua2lxq/", `https://redd.it/1ua2lxq.json?${JSON_QUERY}`],
    [
      "https://sh.reddit.com/r/programming/s/AbC123xyz/",
      `https://sh.reddit.com/r/programming/s/AbC123xyz.json?${JSON_QUERY}`,
    ],
    [
      "https://old.reddit.com/r/programming/comments/1ua2lxq/title.json/",
      `https://old.reddit.com/r/programming/comments/1ua2lxq/title.json?${JSON_QUERY}`,
    ],
    [
      ORIGINAL_URL,
      `https://www.reddit.com/r/programming/comments/1ua2lxq/old_software.json?${JSON_QUERY}`,
    ],
  ])("turns %s into %s", (source, expected) => {
    expect(redditJsonUrl(source)).toBe(expected);
  });

  it.each([
    "not a url",
    "https://example.com/r/programming/comments/1ua2lxq/title",
    "https://www.reddit.com/r/programming/",
    "file:///r/programming/comments/1ua2lxq/title",
  ])("rejects a non-thread URL before fetching: %s", async (source) => {
    expect(() => redditJsonUrl(source)).toThrow();
    const fetch = vi.fn();
    const outcome = await extractReddit(source, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      lookup: publicLookup(),
      maxBytes: 1024,
    });
    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("extractReddit", () => {
  it("fetches safely with browser JSON headers and returns the manual-import parser's exact body", async () => {
    const hosts: string[] = [];
    const d = deps(jsonResponse(), { lookup: publicLookup(hosts) });

    const outcome = await extractReddit(ORIGINAL_URL, d);

    expect(outcome).toEqual({
      kind: "extracted",
      body: buildRedditImport(ORIGINAL_URL, THREAD_JSON),
    });
    expect(hosts).toEqual(["www.reddit.com"]);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(d.fetch).mock.calls[0]!;
    expect(url).toBe(
      `https://www.reddit.com/r/programming/comments/1ua2lxq/old_software.json?${JSON_QUERY}`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toBe(BROWSER_USER_AGENT);
    expect(headers.get("accept-language")).toBe("en-US,en;q=0.9");
    expect(init).toMatchObject({ redirect: "manual" });
  });

  it("checks every redirect and refuses a private destination before fetching it", async () => {
    const hosts: string[] = [];
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://private.example/thread.json" } }),
    );
    const lookup: RedditDeps["lookup"] = async (hostname) => {
      hosts.push(hostname);
      return [{ address: hostname === "private.example" ? "192.168.1.2" : "93.184.216.34" }];
    };

    const outcome = await extractReddit(ORIGINAL_URL, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      lookup,
      maxBytes: 1024,
    });

    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
    expect(hosts).toEqual(["www.reddit.com", "private.example"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-applies the .json request shape when a shortlink redirect drops it", async () => {
    // redd.it and /s/ share links resolve to the canonical thread page; the
    // Location carries neither the .json suffix nor the raw_json query. The
    // route re-applies both to the redirect target so a shortlink recovers the
    // same unescaped listing a canonical URL would.
    const sourceUrl = "https://redd.it/1ua2lxq/";
    const canonical = "https://www.reddit.com/r/programming/comments/1ua2lxq/old_software/";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: canonical } }))
      .mockResolvedValueOnce(jsonResponse());

    const outcome = await extractReddit(sourceUrl, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      lookup: publicLookup(),
      maxBytes: 1024 * 1024,
    });

    expect(outcome).toEqual({ kind: "extracted", body: buildRedditImport(sourceUrl, THREAD_JSON) });
    expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toEqual([
      `https://redd.it/1ua2lxq.json?${JSON_QUERY}`,
      `https://www.reddit.com/r/programming/comments/1ua2lxq/old_software.json?${JSON_QUERY}`,
    ]);
  });

  it("follows a redirect to a non-thread destination without rewriting it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://www.reddit.com/login/" } }),
      )
      .mockResolvedValueOnce(new Response("<html>login wall</html>"));

    const outcome = await extractReddit(ORIGINAL_URL, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      lookup: publicLookup(),
      maxBytes: 1024,
    });

    expect(outcome).toMatchObject({ kind: "manual" });
    expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toEqual([
      `https://www.reddit.com/r/programming/comments/1ua2lxq/old_software.json?${JSON_QUERY}`,
      "https://www.reddit.com/login/",
    ]);
  });

  it("rejects URL credentials before fetch and redacts them from the error", async () => {
    const fetch = vi.fn();
    const outcome = await extractReddit(
      "https://alice:secret@www.reddit.com/r/programming/comments/1ua2lxq/title/",
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        lookup: publicLookup(),
        maxBytes: 1024,
      },
    );

    expect(outcome).toMatchObject({ kind: "error", code: "BlockedHostError" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])("maps HTTP %i to the manual skill fallback without reading the body", async (status) => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const outcome = await extractReddit(
      ORIGINAL_URL,
      deps(new Response(body, { status, headers: { "content-type": "text/html" } })),
    );

    // The detail names the condition: a 403 wall and a transient 429 read very
    // differently in a run report, but both route to the same skill fallback.
    expect(outcome).toMatchObject({
      kind: "manual",
      detail: expect.stringMatching(new RegExp(`HTTP ${status}.*reddit-import skill`, "i")),
    });
    expect(cancelled).toBe(true);
  });

  it("maps a successful HTML content type to manual without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const outcome = await extractReddit(
      ORIGINAL_URL,
      deps(new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })),
    );

    expect(outcome).toMatchObject({
      kind: "manual",
      detail: expect.stringMatching(/HTML.*reddit-import skill/i),
    });
    expect(cancelled).toBe(true);
  });

  it.each(["<!doctype html><title>blocked</title>", "  <html><body>challenge</body></html>"])(
    "maps an HTML-looking body without a useful content type to manual",
    async (body) => {
      const outcome = await extractReddit(ORIGINAL_URL, deps(new Response(body)));
      expect(outcome).toMatchObject({
        kind: "manual",
        detail: expect.stringMatching(/HTML.*reddit-import skill/i),
      });
    },
  );

  it.each([404, 410])("maps HTTP %i to dead", async (status) => {
    const outcome = await extractReddit(ORIGINAL_URL, deps(new Response(null, { status })));
    expect(outcome).toMatchObject({ kind: "dead", detail: expect.stringContaining(String(status)) });
  });

  it("maps a server error without leaking its response body", async () => {
    const secretBody = "upstream body must stay private";
    const outcome = await extractReddit(ORIGINAL_URL, deps(new Response(secretBody, { status: 500 })));
    expect(outcome).toMatchObject({ kind: "error", code: "BadStatusError" });
    expect(JSON.stringify(outcome)).not.toContain(secretBody);
  });

  it("maps timeout and redirect exhaustion to structured errors", async () => {
    const stalledFetch = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    const timeout = await extractReddit(
      ORIGINAL_URL,
      {
        fetch: stalledFetch as unknown as typeof globalThis.fetch,
        lookup: publicLookup(),
        maxBytes: 1024,
        timeoutMs: 5,
      },
    );
    expect(timeout).toMatchObject({ kind: "error", code: "FetchTimeoutError" });

    const redirecting = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: ORIGINAL_URL } }),
    );
    const exhausted = await extractReddit(ORIGINAL_URL, {
      fetch: redirecting as unknown as typeof globalThis.fetch,
      lookup: publicLookup(),
      maxBytes: 1024,
    });
    expect(exhausted).toMatchObject({ kind: "error", code: "TooManyRedirectsError" });
  });

  it("enforces declared and streamed response-size ceilings", async () => {
    const declared = await extractReddit(
      ORIGINAL_URL,
      deps(
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "100" },
        }),
        { maxBytes: 10 },
      ),
    );
    expect(declared).toMatchObject({ kind: "error", code: "OversizedResponseError" });

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
        controller.enqueue(new TextEncoder().encode("789012"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamed = await extractReddit(
      ORIGINAL_URL,
      deps(new Response(stream, { headers: { "content-type": "application/json" } }), { maxBytes: 10 }),
    );
    expect(streamed).toMatchObject({ kind: "error", code: "OversizedResponseError" });
    expect(cancelled).toBe(true);
  });

  it.each(["{}", "[]", JSON.stringify([{ kind: "Listing", data: { children: [] } }])])(
    "maps an invalid Reddit listing to a structured parse error",
    async (body) => {
      const outcome = await extractReddit(ORIGINAL_URL, deps(jsonResponse(body)));
      expect(outcome).toMatchObject({ kind: "error", code: "InvalidRedditListingError" });
      expect(JSON.stringify(outcome)).not.toContain(body);
    },
  );
});
