import { describe, expect, it, vi } from "vitest";
import {
  dryRunR2,
  makeR2Client,
  makeR2RestClient,
  makeVectorizeClient,
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

  it("putIfAbsent sends If-None-Match and returns true on success", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 200 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);

    await expect(r2.putIfAbsent("index/by-url/a", "{}", { contentType: "application/json" })).resolves.toBe(true);

    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.headers.get("if-none-match")).toBe("*");
    expect(req.headers.get("content-type")).toBe("application/json");
  });

  it("putIfAbsent returns false when R2 reports an existing object", async () => {
    for (const status of [409, 412]) {
      const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("exists", { status }));
      const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
      await expect(r2.putIfAbsent("index/by-url/a", "{}")).resolves.toBe(false);
    }
  });

  it("putIfAbsent throws on non-conditional failures", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("boom", { status: 500 }));
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    await expect(r2.putIfAbsent("k", "v")).rejects.toThrow(/R2 PUT k failed: 500 boom/);
  });

  it("dry-run putIfAbsent logs and returns true", async () => {
    const lines: string[] = [];
    const r2 = dryRunR2((line) => lines.push(line));
    await expect(r2.putIfAbsent("index/by-url/a", "{}")).resolves.toBe(true);
    expect(lines).toEqual(["[dry-run] R2 PUT if absent index/by-url/a"]);
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

  it("head returns true on ok, false otherwise", async () => {
    const okFetch = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 200 }));
    const missFetch = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 404 }));
    expect(await makeR2Client(r2Config, okFetch as unknown as typeof fetch).head("k")).toBe(true);
    expect(await makeR2Client(r2Config, missFetch as unknown as typeof fetch).head("k")).toBe(false);
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
            <Contents><Key>index/list.json</Key></Contents>
            <Contents><Key>readings/a&amp;b/manifest.json</Key></Contents>
          </ListBucketResult>`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <IsTruncated>false</IsTruncated>
            <Contents><Key>index/by-id/rd_1</Key></Contents>
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

  it("getBytes round-trips binary bodies with their content type", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const r2 = makeR2Client(r2Config, fetchFn as unknown as typeof fetch);
    const out = await r2.getBytes("readings/a/raw.pdf");
    expect(out?.contentType).toBe("application/pdf");
    expect([...(out?.body ?? [])]).toEqual([...bytes]);

    const missFetch = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("", { status: 404 }));
    expect(await makeR2Client(r2Config, missFetch as unknown as typeof fetch).getBytes("k")).toBeNull();
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

  it("getBytes round-trips binary bodies; 404 is null", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const r2 = makeR2RestClient(restCfg, fetchFn as unknown as typeof fetch);
    const out = await r2.getBytes("readings/a/raw.pdf");
    expect(out?.contentType).toBe("application/pdf");
    expect([...(out?.body ?? [])]).toEqual([...bytes]);

    const missFetch = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response("", { status: 404 }),
    );
    expect(await makeR2RestClient(restCfg, missFetch as unknown as typeof fetch).getBytes("k")).toBeNull();
  });

  it("putIfAbsent returns false on 412", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(
      async () => new Response("exists", { status: 412 }),
    );
    const r2 = makeR2RestClient(restCfg, fetchFn as unknown as typeof fetch);
    await expect(r2.putIfAbsent("index/by-url/a", "{}")).resolves.toBe(false);
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

describe("makeVectorizeClient", () => {
  it("POSTs ndjson to the upsert endpoint", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
    const vec = makeVectorizeClient(
      { accountId: "acct123", index: "reading-lite", apiToken: "cf-token" },
      fetchFn as unknown as typeof fetch,
    );
    await vec.upsert([
      { id: "rd_a", values: [0.1, 0.2], metadata: { url: "https://x" } },
      { id: "rd_b", values: [0.3], metadata: { url: "https://y" } },
    ]);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/accounts/acct123/vectorize/v2/indexes/reading-lite/upsert");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer cf-token");
    expect(headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (init.body as string).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("rd_a");
  });

  it("throws when upsert fails", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("bad", { status: 400 }));
    const vec = makeVectorizeClient(
      { accountId: "a", index: "i", apiToken: "t" },
      fetchFn as unknown as typeof fetch,
    );
    await expect(vec.upsert([{ id: "x", values: [1], metadata: {} }])).rejects.toThrow(/Vectorize/);
  });

  it("queries by vector and returns matches with metadata", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({
          result: {
            matches: [
              { id: "rd_a", score: 0.9, metadata: { url: "https://x", title: "X" } },
              { id: "rd_b", score: 0.7, metadata: { url: "https://y" } },
            ],
          },
          success: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const vec = makeVectorizeClient(
      { accountId: "acct123", index: "reading-lite", apiToken: "cf-token" },
      fetchFn as unknown as typeof fetch,
    );
    const matches = await vec.query([0.1, 0.2], { topK: 5, returnMetadata: true });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ id: "rd_a", score: 0.9 });
    expect(matches[0]!.metadata).toMatchObject({ url: "https://x", title: "X" });
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/indexes/reading-lite/query");
    const body = JSON.parse(init.body as string);
    expect(body.topK).toBe(5);
    expect(body.vector).toEqual([0.1, 0.2]);
  });

  it("throws when query fails", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("no", { status: 500 }));
    const vec = makeVectorizeClient(
      { accountId: "a", index: "i", apiToken: "t" },
      fetchFn as unknown as typeof fetch,
    );
    await expect(vec.query([1], { topK: 1 })).rejects.toThrow(/Vectorize/);
  });

  it("fetches stored vectors by id, tolerating both result shapes", async () => {
    const vectors = [
      { id: "rd_a", values: [0.1], metadata: { url: "https://x" } },
      { id: "usr_1:rd_a", values: [0.1], namespace: "usr_1" },
    ];
    for (const result of [vectors, { vectors }]) {
      const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
        new Response(JSON.stringify({ result, success: true }), { status: 200 }),
      );
      const vec = makeVectorizeClient(
        { accountId: "acct123", index: "reading-lite", apiToken: "cf-token" },
        fetchFn as unknown as typeof fetch,
      );
      const out = await vec.getByIds(["rd_a", "usr_1:rd_a"]);
      expect(out).toEqual(vectors);
      const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
      expect(url).toContain("/indexes/reading-lite/get_by_ids");
      expect(JSON.parse(init.body as string)).toEqual({ ids: ["rd_a", "usr_1:rd_a"] });
    }
  });

  it("getByIds normalizes a null namespace to absent — unnamespaced means undefined", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(
        JSON.stringify({
          result: [
            { id: "rd_a", values: [0.1], namespace: null, metadata: { url: "https://x" } },
            { id: "usr_1:rd_a", values: [0.1], namespace: "usr_1" },
          ],
          success: true,
        }),
        { status: 200 },
      ),
    );
    const vec = makeVectorizeClient(
      { accountId: "a", index: "i", apiToken: "t" },
      fetchFn as unknown as typeof fetch,
    );
    const out = await vec.getByIds(["rd_a", "usr_1:rd_a"]);
    expect(out[0]).toEqual({ id: "rd_a", values: [0.1], metadata: { url: "https://x" } });
    expect("namespace" in out[0]!).toBe(false);
    expect(out[1]?.namespace).toBe("usr_1");
  });

  it("getByIds with no ids makes no request; errors throw", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () => new Response("no", { status: 500 }));
    const vec = makeVectorizeClient(
      { accountId: "a", index: "i", apiToken: "t" },
      fetchFn as unknown as typeof fetch,
    );
    expect(await vec.getByIds([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(vec.getByIds(["rd_a"])).rejects.toThrow(/get_by_ids/);
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
        putIfAbsent: async (key: string) => (ops.push(`putIfAbsent ${key}`), true),
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
    await rooted.putIfAbsent("index/by-url/abc", "x");
    await rooted.get("readings/p/manifest.json");
    await rooted.head("readings/p/raw.html");
    await rooted.delete("readings/p/extracted.md");
    expect(ops).toEqual([
      `put ${keyRoot}index/list.json`,
      `putIfAbsent ${keyRoot}index/by-url/abc`,
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

describe("tenant-namespaced Vectorize", () => {
  const cfg = { accountId: "acct123", index: "idx", apiToken: "tok" };
  const NS = "usr_550e8400-e29b-41d4-a716-446655440000";

  it("stamps the namespace on upserted vectors and query bodies", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ result: { matches: [] } }), { status: 200 }),
    );
    const client = makeVectorizeClient({ ...cfg, namespace: NS }, fetchFn as unknown as typeof fetch);
    await client.upsert([{ id: "rd_a", values: [1], metadata: {} }]);
    const upsertBody = String(fetchFn.mock.calls[0]![1]!.body);
    expect(JSON.parse(upsertBody)).toMatchObject({ id: "rd_a", namespace: NS });
    await client.query([1], { topK: 3 });
    const queryBody = JSON.parse(String(fetchFn.mock.calls[1]![1]!.body));
    expect(queryBody.namespace).toBe(NS);
  });

  it("omits the namespace for the global (pre-tenant) selection", async () => {
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ result: { matches: [] } }), { status: 200 }),
    );
    const client = makeVectorizeClient(cfg, fetchFn as unknown as typeof fetch);
    await client.upsert([{ id: "rd_a", values: [1], metadata: {} }]);
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body))).not.toHaveProperty("namespace");
    await client.query([1], { topK: 3 });
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]!.body))).not.toHaveProperty("namespace");
  });
});
