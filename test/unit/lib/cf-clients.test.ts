import { describe, expect, it, vi } from "vitest";
import {
  makeR2Client,
  refreshS3RequestDeps,
  makeR2RestClient,
  r2InventoryClientFromVars,
  withKeyRoot,
} from "../../../scripts/lib/cf-clients";

const r2Config = {
  accountId: "acct123",
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  bucket: "reading-lite",
};

describe("makeR2Client", () => {
  it("signs and PUTs to the bucket+key URL", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 200 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    await r2.put("readings/2026/x/manifest.json", "{}", { contentType: "application/json" });
    expect(fetchFn).toHaveBeenCalledOnce();
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("acct123.r2.cloudflarestorage.com/reading-lite/");
    expect(req.url).toContain("readings/2026/x/manifest.json");
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it("throws when PUT fails", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("boom", { status: 500 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    await expect(r2.put("k", "v")).rejects.toThrow(/R2 PUT/);
  });

  it("GET returns the body text on 200", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("hello body", { status: 200 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    expect(await r2.get("some/key")).toBe("hello body");
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("GET");
  });

  it("GET returns null on 404 (absent object)", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("no", { status: 404 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    expect(await r2.get("missing")).toBeNull();
  });

  it("GET throws on a non-404 error", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("nope", { status: 503 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    await expect(r2.get("k")).rejects.toThrow(/R2 GET/);
  });

  it("head distinguishes present, absent, and storage failure", async () => {
    const okFetch = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 200 }));
    const missFetch = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 404 }));
    const failedFetch = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("boom", { status: 503 }));
    expect(await makeR2Client(r2Config, okFetch as unknown as typeof fetch).head("k")).toBe(true);
    expect(await makeR2Client(r2Config, missFetch as unknown as typeof fetch).head("k")).toBe(false);
    await expect(makeR2Client(r2Config, failedFetch as unknown as typeof fetch).head("k")).rejects.toThrow(/R2 HEAD/);
  });

  it("lists object keys across continuation-token pages", async () => {
    const fetchFn = vi
      .fn<(input: any, init?: any) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <IsTruncated>true</IsTruncated>
            <NextContinuationToken>next token</NextContinuationToken>
            <Contents><Key>index/list.json</Key><Size>0</Size><ETag>etag</ETag></Contents>
            <Contents><Key>readings/a&amp;b/manifest.json</Key><Size>0</Size><ETag>etag</ETag></Contents>
          </ListBucketResult>`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <IsTruncated>false</IsTruncated>
            <Contents><Key>index/by-id/rd_1</Key><Size>0</Size><ETag>etag</ETag></Contents>
          </ListBucketResult>`,
          { status: 200 },
        ),
      );
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);

    await expect(r2.listKeys()).resolves.toEqual([
      "index/list.json",
      "readings/a&b/manifest.json",
      "index/by-id/rd_1",
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const second = fetchFn.mock.calls[1]![0] as Request;
    expect(second.url).toContain("continuation-token=next+token");
  });

  it("lists object metadata with sizes and unquoted etags, honoring a prefix", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <Contents><Key>index/list.json</Key><Size>120</Size><ETag>&quot;abc123&quot;</ETag></Contents>
          <Contents><Key>readings/a/manifest.json</Key><Size>456</Size><ETag>&quot;def456&quot;</ETag></Contents>
        </ListBucketResult>`,
        { status: 200 },
      ),
    );
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    await expect(r2.listObjects("index/")).resolves.toEqual([
      { key: "index/list.json", size: 120, etag: "abc123" },
      { key: "readings/a/manifest.json", size: 456, etag: "def456" },
    ]);
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.url).toContain("prefix=index%2F");
  });

  it("deletes object keys", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 200 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);

    await r2.delete("index/list.json");

    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("acct123.r2.cloudflarestorage.com/reading-lite/index/list.json");
  });
});

describe("makeR2RestClient", () => {
  const restCfg = { accountId: "acct123", apiToken: "cf-token", bucket: "reading-lite-staging" };

  it("lists object metadata from the JSON REST envelope, following cursors", async () => {
    const fetchFn = vi
      .fn<(input: any, init?: any) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ key: "index/list.json", size: 120, etag: "abc123" }],
            result_info: { cursor: "next-page", is_truncated: true, per_page: 1000 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ key: "readings/a/manifest.json", size: "456", etag: '"def456"' }],
            result_info: { is_truncated: false },
          }),
          { status: 200 },
        ),
      );
    const r2 = makeR2RestClient(restCfg, fetchFn as unknown as typeof fetch);
    await expect(r2.listObjects("index/")).resolves.toEqual([
      { key: "index/list.json", size: 120, etag: "abc123" },
      { key: "readings/a/manifest.json", size: 456, etag: "def456" },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const first = fetchFn.mock.calls[0]![0] as string;
    expect(first).toContain("api.cloudflare.com/client/v4/accounts/acct123/r2/buckets/reading-lite-staging/objects?");
    expect(first).toContain("prefix=index%2F");
    expect(fetchFn.mock.calls[1]![0]).toContain("cursor=next-page");
    expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer cf-token");
  });

  it("PUTs raw bytes to the REST object URL with the bearer token", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ success: true, result: { etag: "abc" } }), { status: 200 }),
    );
    const r2 = makeR2RestClient(restCfg, fetchFn as unknown as typeof fetch);
    await r2.put("readings/2026/x/manifest.json", "{}", { contentType: "application/json" });
    expect(fetchFn).toHaveBeenCalledOnce();
    const url = fetchFn.mock.calls[0]![0] as string;
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/r2/buckets/reading-lite-staging/objects/readings/2026/x/manifest.json",
    );
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("{}");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer cf-token");
    expect(headers.get("content-type")).toBe("application/json");
  });
});

describe("r2InventoryClientFromVars", () => {
  it("prefers S3 credentials when access keys are present", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response("", { status: 200 }),
    );
    const r2 = r2InventoryClientFromVars(
      {
        CLOUDFLARE_ACCOUNT_ID: "acct123",
        CORPUS_R2_ACCESS_KEY: "AKIA",
        CORPUS_R2_SECRET_KEY: "secret",
        CLOUDFLARE_API_TOKEN: "cf-token",
      },
      "reading-lite",
      fetchFn as unknown as typeof fetch,
    );
    await r2.put("k", "v");
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.url).toContain("acct123.r2.cloudflarestorage.com");
  });

  it("falls back to the REST API when only a Cloudflare API token is present", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const r2 = r2InventoryClientFromVars(
      {
        CLOUDFLARE_ACCOUNT_ID: "acct123",
        CLOUDFLARE_API_TOKEN: "cf-token",
      },
      "reading-lite-staging",
      fetchFn as unknown as typeof fetch,
    );
    await r2.put("k", "v");
    expect(fetchFn.mock.calls[0]![0]).toContain(
      "api.cloudflare.com/client/v4/accounts/acct123/r2/buckets/reading-lite-staging/objects/k",
    );
  });

  it("throws when neither S3 keys nor an API token are present", () => {
    expect(() =>
      r2InventoryClientFromVars({ CLOUDFLARE_ACCOUNT_ID: "acct123" }, "reading-lite"),
    ).toThrow(/CLOUDFLARE_API_TOKEN/);
  });
});

// reading-lite-s1k.4.3: the batch pipeline speaks relative keys; the tenant
// root is applied by wrapping the client, so every phase module stays
// root-agnostic while all traffic is confined to one tenant's namespace.
describe("withKeyRoot", () => {
  const keyRoot = "u/usr_550e8400-e29b-41d4-a716-446655440000/";

  function recordingClient(keys: string[] = []) {
    const ops: string[] = [];
    return {
      ops,
      client: {
        put: async (key: string) => void ops.push(`put ${key}`),
        get: async (key: string) => (ops.push(`get ${key}`), null),
        head: async (key: string) => (ops.push(`head ${key}`), false),
        delete: async (key: string) => void ops.push(`delete ${key}`),
        listKeys: async () => keys,
      },
    };
  }

  it("prefixes every key-addressed operation with the root", async () => {
    const { ops, client } = recordingClient();
    const rooted = withKeyRoot(client, keyRoot);
    await rooted.put("index/list.json", "x");
    await rooted.get("readings/p/manifest.json");
    await rooted.head("readings/p/raw.html");
    await rooted.delete("readings/p/extracted.md");
    expect(ops).toEqual([
      `put ${keyRoot}index/list.json`,
      `get ${keyRoot}readings/p/manifest.json`,
      `head ${keyRoot}readings/p/raw.html`,
      `delete ${keyRoot}readings/p/extracted.md`,
    ]);
  });

  it("lists only this tenant's keys, stripped back to relative form", async () => {
    const { client } = recordingClient([
      `${keyRoot}readings/a/manifest.json`,
      `${keyRoot}index/list.json`,
      "readings/global/manifest.json",
      "u/usr_11111111-1111-4111-8111-111111111111/readings/b/manifest.json",
    ]);
    const rooted = withKeyRoot(client, keyRoot);
    expect(await rooted.listKeys()).toEqual([
      "readings/a/manifest.json",
      "index/list.json",
    ]);
  });

  it("is the identity for the global root", async () => {
    const { client } = recordingClient(["readings/a/manifest.json"]);
    expect(withKeyRoot(client, "")).toBe(client);
  });
});

describe("makeR2RestClient — 429 backoff", () => {
  const restCfg = { accountId: "acct123", apiToken: "cf-token", bucket: "reading-lite" };

  it("retries a throttled GET after Retry-After instead of reporting the object unreadable", async () => {
    const fetchFn = vi
      .fn<(input: any, init?: any) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errors: [{ code: 971, message: "Please wait" }] }), {
          status: 429,
          headers: { "retry-after": "3" },
        }),
      )
      .mockResolvedValueOnce(new Response('{"id":"rd_a"}', { status: 200 }));
    const sleep = vi.fn(async (_ms: number) => {});
    const r2 = makeR2RestClient(restCfg, fetchFn as unknown as typeof fetch, { sleep });

    await expect(r2.get("index/by-id/rd_a")).resolves.toBe('{"id":"rd_a"}');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it("gives up after the retry budget and surfaces the 429", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response("throttled", { status: 429 }),
    );
    const sleep = vi.fn(async (_ms: number) => {});
    const r2 = makeR2RestClient(restCfg, fetchFn as unknown as typeof fetch, { sleep });

    await expect(r2.get("index/by-id/rd_a")).rejects.toThrow(/429/);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });
});

describe("makeR2Client request timeout and transient retry", () => {
  // The deadline and retry are the corpus refresh commands' policy, so every
  // case below builds the client with refreshS3RequestDeps(); the last case in
  // this block covers what every other caller still gets.
  const okResponse = () => new Response("body", { status: 200 });
  const abortError = () => new DOMException("The operation was aborted.", "TimeoutError");

  function harness(
    responses: Array<Response | Error>,
    overrides: Parameters<typeof makeR2Client>[2] = {},
  ) {
    let call = 0;
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => {
      const next = responses[Math.min(call++, responses.length - 1)]!;
      if (next instanceof Error || next instanceof DOMException) throw next;
      return next;
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const signals: number[] = [];
    const r2 = makeR2Client(
      r2Config,
      fetchFn as unknown as typeof fetch,
      refreshS3RequestDeps({
        sleep,
        timeoutSignal: (ms) => {
          signals.push(ms);
          return new AbortController().signal;
        },
        ...overrides,
      }),
    );
    return { r2, fetchFn, sleep, signals };
  }

  it("is a 30s deadline and three attempts wherever it is opted into", () => {
    expect(refreshS3RequestDeps()).toMatchObject({ timeoutMs: 30_000, maxAttempts: 3 });
  });

  it("aborts every request after 30 seconds", async () => {
    const h = harness([okResponse()]);
    await h.r2.get("readings/2026/rd_a/manifest.json");
    expect(h.signals).toEqual([30_000]);
    const req = h.fetchFn.mock.calls[0]![0] as Request;
    expect(req.signal).toBeDefined();
  });

  it("retries a 5xx and returns the eventual success", async () => {
    const h = harness([new Response("slow down", { status: 503 }), okResponse()]);
    await expect(h.r2.get("k")).resolves.toBe("body");
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([250]);
    // A fresh deadline per attempt, so a slow first try cannot starve the retry.
    expect(h.signals).toEqual([30_000, 30_000]);
  });

  it("retries a throttled request and waits as long as R2 asked", async () => {
    const h = harness([
      new Response("throttled", { status: 429, headers: { "retry-after": "5" } }),
      okResponse(),
    ]);
    await expect(h.r2.get("k")).resolves.toBe("body");
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000]);
  });

  it("clamps an absurd throttle hint and falls back to backoff without one", async () => {
    const huge = harness([
      new Response("throttled", { status: 429, headers: { "retry-after": "86400" } }),
      okResponse(),
    ]);
    await expect(huge.r2.get("k")).resolves.toBe("body");
    expect(huge.sleep.mock.calls.map(([ms]) => ms)).toEqual([30_000]);

    const unhinted = harness([new Response("throttled", { status: 429 }), okResponse()]);
    await expect(unhinted.r2.get("k")).resolves.toBe("body");
    expect(unhinted.sleep.mock.calls.map(([ms]) => ms)).toEqual([250]);
  });

  it("gives up after three attempts and surfaces the last failure", async () => {
    const h = harness([new Response("boom", { status: 500 })]);
    await expect(h.r2.get("k")).rejects.toThrow(/R2 GET k failed: 500/);
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it("retries a timed-out request and rethrows the abort once the budget is spent", async () => {
    const h = harness([abortError()]);
    await expect(h.r2.get("k")).rejects.toThrow(/aborted/);
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
  });

  it("recovers when only the first attempt times out", async () => {
    const h = harness([abortError(), okResponse()]);
    await expect(h.r2.get("k")).resolves.toBe("body");
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry an absent object", async () => {
    const missing = harness([new Response("no", { status: 404 })]);
    await expect(missing.r2.get("k")).resolves.toBeNull();
    expect(missing.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries an unconditional PUT, which repeats to the same bytes", async () => {
    const h = harness([new Response("boom", { status: 503 }), okResponse()]);
    await expect(h.r2.put("index/list.json", "{}")).resolves.toBeUndefined();
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a status the server will never serve", async () => {
    const h = harness([new Response("nope", { status: 501 })]);
    await expect(h.r2.get("k")).rejects.toThrow(/R2 GET k failed: 501/);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("leaves every other caller on one attempt and no deadline", async () => {
    // corpus-ingest, corpus-recover, purge-connections
    // and staging-teardown build the client without the refresh policy; a
    // deadline they were never written against must not appear under them.
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response("boom", { status: 503 }),
    );
    const bare = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    await expect(bare.get("k")).rejects.toThrow(/R2 GET k failed: 503/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0]![0] as Request).signal.aborted).toBe(false);
    expect((fetchFn.mock.calls[0]![0] as Request).signal.reason).toBeUndefined();
  });

  it("retries a transient LIST page without restarting the listing", async () => {
    const page = (truncated: boolean) =>
      new Response(
        `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
          `<Contents><Key>a</Key><Size>1</Size><ETag>&quot;e&quot;</ETag></Contents>` +
          (truncated ? "<NextContinuationToken>t1</NextContinuationToken>" : "") +
          `</ListBucketResult>`,
        { status: 200 },
      );
    const h = harness([page(true), new Response("boom", { status: 503 }), page(false)]);
    await expect(h.r2.listKeys()).resolves.toEqual(["a", "a"]);
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
  });
});
