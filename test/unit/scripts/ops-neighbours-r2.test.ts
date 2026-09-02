import { describe, expect, it, vi } from "vitest";
import {
  chooseNeighboursBackend,
  describeBackend,
  directNeighboursR2,
} from "../../../scripts/ops-lib/neighbours-r2";
import {
  makeR2Client,
  makeR2RestClient,
  makeVectorizeClient,
} from "../../../scripts/lib/cf-clients";
import type { R2Deps } from "../../../scripts/corpus-lib/wrangler-r2";

const S3_CONFIG = {
  accountId: "acct123",
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  bucket: "reading-lite-staging",
};

const GLOBAL: R2Deps = { bucket: "reading-lite-staging", keyRoot: "" };
const TENANT: R2Deps = { bucket: "reading-lite-staging", keyRoot: "u/usr_1/" };

type FetchStub = ReturnType<typeof vi.fn<(input: any, init?: any) => Promise<Response>>>;

function stub(...responses: Array<() => Response>): FetchStub {
  let i = 0;
  return vi.fn<(input: any, init?: any) => Promise<Response>>(async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return next();
  });
}

function vectorizeResponse(matches: unknown[]): Response {
  return new Response(
    JSON.stringify({ result: { count: matches.length, matches }, success: true }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The adapter under test, over an S3 R2 client and a REST Vectorize client. */
function adapter(fetchFn: FetchStub) {
  return directNeighboursR2({
    r2: (bucket) => makeR2Client({ ...S3_CONFIG, bucket }, fetchFn as unknown as typeof fetch),
    vectorize: (index, namespace) =>
      makeVectorizeClient(
        { accountId: "acct123", apiToken: "cf-token", index, ...(namespace === undefined ? {} : { namespace }) },
        fetchFn as unknown as typeof fetch,
      ),
    // No real backoff: contention is driven by the responses, not by waiting.
    listCas: { sleep: async () => {}, random: () => 0 },
  });
}

function listIndexResponse(items: unknown[], etag: string): Response {
  return new Response(JSON.stringify({ version: 1, items }), {
    status: 200,
    headers: { "content-type": "application/json", etag: `"${etag}"` },
  });
}

function listRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    key_prefix: `readings/${id}`,
    url: `https://example.com/${id}`,
    status: "ready",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("chooseNeighboursBackend", () => {
  it("picks direct when CORPUS_R2_* keys and a Cloudflare token are present", () => {
    expect(
      chooseNeighboursBackend({
        local: false,
        vars: {
          CORPUS_R2_ACCOUNT_ID: "acct",
          CORPUS_R2_ACCESS_KEY: "AKIA",
          CORPUS_R2_SECRET_KEY: "secret",
          CORPUS_CF_API_TOKEN: "tok",
        },
      }),
    ).toEqual({ backend: "direct", reason: "CORPUS_R2_* keys", accountId: "acct" });
  });

  it("picks direct on CLOUDFLARE_API_TOKEN alone", () => {
    expect(
      chooseNeighboursBackend({
        local: false,
        vars: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      }),
    ).toEqual({ backend: "direct", reason: "CLOUDFLARE_API_TOKEN", accountId: "acct" });
  });

  // Vectorize has no S3 access-key path, so R2 keys without a token cannot
  // serve tier 1 at all — half a direct backend is not a direct backend.
  it("stays on wrangler when S3 keys are present but no Cloudflare token is", () => {
    expect(
      chooseNeighboursBackend({
        local: false,
        vars: {
          CORPUS_R2_ACCOUNT_ID: "acct",
          CORPUS_R2_ACCESS_KEY: "AKIA",
          CORPUS_R2_SECRET_KEY: "secret",
        },
      }).backend,
    ).toBe("wrangler");
  });

  it("falls back to wrangler with no credentials at all", () => {
    expect(chooseNeighboursBackend({ local: false, vars: {} })).toEqual({
      backend: "wrangler",
      reason: "no CORPUS_R2_*/CLOUDFLARE_API_TOKEN credentials",
    });
  });

  it("--via wrangler overrides present credentials", () => {
    expect(
      chooseNeighboursBackend({
        via: "wrangler",
        local: false,
        vars: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      }),
    ).toEqual({ backend: "wrangler", reason: "--via wrangler" });
  });

  it("--local uses wrangler even with credentials, because miniflare is process-local", () => {
    expect(
      chooseNeighboursBackend({
        local: true,
        vars: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" },
      }),
    ).toEqual({ backend: "wrangler", reason: "--local" });
  });

  // Forcing direct without credentials must reach the client builder, whose
  // "missing credential: …" message names what to set — silently spawning
  // wrangler instead would hide the misconfiguration the operator asked about.
  it("--via direct forces direct even with no credentials", () => {
    expect(chooseNeighboursBackend({ via: "direct", local: false, vars: {} })).toEqual({
      backend: "direct",
      reason: "--via direct",
    });
  });

  it("names the chosen path and why in the header line", () => {
    expect(describeBackend({ backend: "direct", reason: "CORPUS_R2_* keys" })).toEqual([
      "Storage: direct (S3/REST) — CORPUS_R2_* keys",
    ]);
    expect(describeBackend({ backend: "wrangler", reason: "--local" })).toEqual([
      "Storage: wrangler — --local",
    ]);
  });

  // Which account's bucket, not just which bucket: staging and production
  // spell some corpus names alike, and the direct path takes the account from
  // whichever credential file the shell happened to load.
  it("names the Cloudflare account the direct path addresses", () => {
    expect(
      describeBackend({ backend: "direct", reason: "CORPUS_R2_* keys", accountId: "acct" }),
    ).toEqual(["Storage: direct (S3/REST) — CORPUS_R2_* keys", "Account: acct"]);
  });

  // The wrangler path resolves its own account from `wrangler login`, so this
  // command has nothing to report about it.
  it("says nothing about the account on the wrangler path", () => {
    expect(
      describeBackend({ backend: "wrangler", reason: "--via wrangler", accountId: "acct" }),
    ).toEqual(["Storage: wrangler — --via wrangler"]);
  });
});

describe("directNeighboursR2 — queryByVectorId", () => {
  it("POSTs vectorId (not a vector) to Vectorize v2 /query with the namespace filter", async () => {
    const fetchFn = stub(() => vectorizeResponse([{ id: "usr_1:rd_a", score: 1 }]));
    await adapter(fetchFn).queryByVectorId("reading-lite-staging", "usr_1:rd_a", 6, "usr_1");

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/vectorize/v2/indexes/reading-lite-staging/query",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cf-token");
    expect(JSON.parse(init.body as string)).toEqual({
      vectorId: "usr_1:rd_a",
      topK: 6,
      returnMetadata: "all",
      namespace: "usr_1",
    });
  });

  // A reverse-neighbour scoping query reads ids and scores only; asking a
  // hundred readings for their title, tldr and tags is transfer for nothing.
  it("asks for no metadata when the caller says it wants none", async () => {
    const fetchFn = stub(() => vectorizeResponse([{ id: "usr_1:rd_a", score: 1 }]));
    await adapter(fetchFn).queryByVectorId("reading-lite-staging", "usr_1:rd_a", 100, "usr_1", {
      metadata: false,
    });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ topK: 100, returnMetadata: "none" });
  });

  it("omits the namespace for the pre-tenant global index", async () => {
    const fetchFn = stub(() => vectorizeResponse([{ id: "rd_a", score: 1 }]));
    await adapter(fetchFn).queryByVectorId("reading-lite-staging", "rd_a", 6, undefined);
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("namespace");
    expect(body.vectorId).toBe("rd_a");
  });

  // A present vector always matches itself, so an empty match list is the
  // missing-vector signal — the same thing wrangler prints as "Could not find
  // any relevant vectors" while exiting zero. Verified against the live
  // staging index: an unknown id answers 200 with count 0, not an error.
  it("returns null for a vector the index does not hold", async () => {
    const fetchFn = stub(() => vectorizeResponse([]));
    await expect(
      adapter(fetchFn).queryByVectorId("reading-lite-staging", "rd_missing", 6, undefined),
    ).resolves.toBeNull();
  });

  // The opposite direction of the same discipline as wrangler-r2: a real
  // failure must never be reported as a corpus gap that does not exist.
  it("throws rather than reporting a missing vector when the API errors", async () => {
    const fetchFn = stub(() => new Response("boom", { status: 500 }));
    await expect(
      adapter(fetchFn).queryByVectorId("reading-lite-staging", "rd_a", 6, undefined),
    ).rejects.toThrow(/Vectorize query failed: 500/);
  });

  // The command owns namespace stripping (it holds the tenant selector), so the
  // adapter must hand back the prefixed id wrangler would have printed.
  it("keeps the namespace prefix on returned ids", async () => {
    const fetchFn = stub(() =>
      vectorizeResponse([
        { id: "usr_1:rd_a", score: 1, namespace: "usr_1" },
        { id: "usr_1:rd_b", score: 0.7, namespace: "usr_1" },
      ]),
    );
    const matches = await adapter(fetchFn).queryByVectorId(
      "reading-lite-staging",
      "usr_1:rd_a",
      6,
      "usr_1",
    );
    expect(matches?.map((m) => m.id)).toEqual(["usr_1:rd_a", "usr_1:rd_b"]);
  });

  // Same parser as the wrangler adapter: identical neighbour objects are what
  // make the two paths produce a byte-identical refresh-report.json.
  it("maps metadata exactly as the wrangler adapter does", async () => {
    const fetchFn = stub(() =>
      vectorizeResponse([
        {
          id: "rd_b",
          score: 0.72,
          metadata: {
            title: "Neighbour",
            tldr: "About N",
            tags: ["ml", 7, "ai"],
            created_at: "2026-08-20T00:00:00.000Z",
            url: "https://b.example/y",
          },
        },
        { id: "rd_c", score: "not-a-number" },
        { id: 42, score: 0.5 },
        null,
      ]),
    );
    const matches = await adapter(fetchFn).queryByVectorId("i", "rd_a", 6, undefined);
    expect(matches).toEqual([
      {
        id: "rd_b",
        score: 0.72,
        title: "Neighbour",
        tldr: "About N",
        tags: ["ml", "ai"],
        created_at: "2026-08-20T00:00:00.000Z",
      },
    ]);
  });
});

describe("directNeighboursR2 — manifest and list reads", () => {
  it("reads one tenant-rooted manifest with a single GET", async () => {
    const fetchFn = stub(() => new Response(JSON.stringify({ id: "rd_a" }), { status: 200 }));
    await expect(adapter(fetchFn).readManifest("readings/rd_a", TENANT)).resolves.toEqual({
      id: "rd_a",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("GET");
    expect(req.url).toContain(
      "reading-lite-staging/u/usr_1/readings/rd_a/manifest.json",
    );
  });

  it("uses no key root for the global layout", async () => {
    const fetchFn = stub(() => new Response("{}", { status: 200 }));
    await adapter(fetchFn).readManifest("readings/rd_a", GLOBAL);
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.url).toContain("reading-lite-staging/readings/rd_a/manifest.json");
    expect(req.url).not.toContain("/u/");
  });

  it("returns null only for a confirmed-absent manifest", async () => {
    const fetchFn = stub(() => new Response("", { status: 404 }));
    await expect(adapter(fetchFn).readManifest("readings/rd_a", GLOBAL)).resolves.toBeNull();
  });

  // Absence and unreadability must stay distinct: a transient read reported as
  // "no manifest" is a corpus gap that does not exist.
  it("throws on a read error rather than reporting the manifest absent", async () => {
    const fetchFn = stub(() => new Response("boom", { status: 403 }));
    await expect(adapter(fetchFn).readManifest("readings/rd_a", GLOBAL)).rejects.toThrow(
      /R2 GET .*failed: 403/,
    );
  });

  it("throws on an unparseable manifest", async () => {
    const fetchFn = stub(() => new Response("not json", { status: 200 }));
    await expect(adapter(fetchFn).readManifest("readings/rd_a", GLOBAL)).rejects.toThrow();
  });

  it("reads index/list.json and returns its items", async () => {
    const fetchFn = stub(() =>
      new Response(JSON.stringify({ version: 1, items: [{ id: "rd_a" }] }), { status: 200 }),
    );
    await expect(adapter(fetchFn).readListIndex(TENANT)).resolves.toEqual({
      items: [{ id: "rd_a" }],
    });
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.url).toContain("reading-lite-staging/u/usr_1/index/list.json");
  });

  it("returns the list index ETag, which is what an incremental run compares against", async () => {
    const fetchFn = stub(() => listIndexResponse([listRow("rd_a")], "etag-1"));
    await expect(adapter(fetchFn).readListIndex(TENANT)).resolves.toMatchObject({
      etag: "etag-1",
    });
  });

  it("round-trips the run marker under the tenant root", async () => {
    const state = {
      version: 1 as const,
      last_run_at: "2026-08-22T12:00:00.000Z",
      last_full_run_at: "2026-08-15T12:00:00.000Z",
      list_row_count: 42,
      list_etag: "etag-1",
    };
    const written: string[] = [];
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "PUT") {
        written.push(await request.text());
        return new Response("", { status: 200 });
      }
      return new Response(written[written.length - 1] ?? "", { status: 200 });
    });
    const r2 = adapter(fetchFn as unknown as FetchStub);
    await r2.writeRefreshState(state, TENANT);
    expect(await r2.readRefreshState(TENANT)).toEqual(state);
    const putUrl = (fetchFn.mock.calls[0]![0] as Request).url;
    expect(putUrl).toContain("reading-lite-staging/u/usr_1/index/refresh-state.json");
  });

  // The first incremental run on a corpus has no marker, and absent must be
  // distinguishable from unreadable: absent means sweep, unreadable is an error.
  it("reports an absent run marker as null and a failed read as an error", async () => {
    await expect(
      adapter(stub(() => new Response("", { status: 404 }))).readRefreshState(GLOBAL),
    ).resolves.toBeNull();
    await expect(
      adapter(stub(() => new Response("boom", { status: 500 }))).readRefreshState(GLOBAL),
    ).rejects.toThrow();
  });

  it("refuses to run against a missing list index", async () => {
    const fetchFn = stub(() => new Response("", { status: 404 }));
    await expect(adapter(fetchFn).readListIndex(GLOBAL)).rejects.toThrow(
      /could not read index\/list\.json from bucket reading-lite-staging/,
    );
  });

  it("refuses a list index with no items array", async () => {
    const fetchFn = stub(() => new Response(JSON.stringify({ version: 1 }), { status: 200 }));
    await expect(adapter(fetchFn).readListIndex(GLOBAL)).rejects.toThrow(/has no items array/);
  });
});

describe("directNeighboursR2 — writes", () => {
  it("PUTs the manifest as compact JSON at the tenant-rooted key", async () => {
    const fetchFn = stub(() => new Response("", { status: 200 }));
    await adapter(fetchFn).putManifest("readings/rd_a", { id: "rd_a", n: 1 }, TENANT);
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("u/usr_1/readings/rd_a/manifest.json");
    expect(req.headers.get("content-type")).toBe("application/json");
    await expect(req.text()).resolves.toBe('{"id":"rd_a","n":1}');
  });

  it("throws when the manifest PUT fails", async () => {
    const fetchFn = stub(() => new Response("boom", { status: 500 }));
    await expect(
      adapter(fetchFn).putManifest("readings/rd_a", {}, GLOBAL),
    ).rejects.toThrow(/R2 PUT/);
  });

  it("merges measured rows into index/list.json under If-Match", async () => {
    const snapshot = { count: 2, max: 0.8, mean: 0.7, computed_at: "2026-09-02T00:00:00.000Z" };
    const fetchFn = stub(
      () => listIndexResponse([listRow("rd_a"), listRow("rd_b")], "v1"),
      () => new Response("", { status: 200 }),
    );

    await adapter(fetchFn).mergeListRows([{ id: "rd_a", similarity: snapshot }], TENANT);

    const [read, write] = fetchFn.mock.calls.map(([input]) => input as Request);
    expect(read!.method).toBe("GET");
    expect(read!.url).toContain("u/usr_1/index/list.json");
    expect(write!.method).toBe("PUT");
    expect(write!.headers.get("if-match")).toBe('"v1"');
    const body = JSON.parse(await write!.text()) as { items: Array<Record<string, unknown>> };
    // Only the measured row changes; the other row is written back as read.
    expect(body.items[0]!.similarity).toEqual(snapshot);
    expect(body.items[1]).toEqual(listRow("rd_b"));
  });

  it("re-reads and re-merges after a 412, keeping a row inserted meanwhile", async () => {
    const snapshot = { count: 1, max: 0.9, mean: 0.9, computed_at: "2026-09-02T00:00:00.000Z" };
    const responses = [
      () => listIndexResponse([listRow("rd_a")], "v1"),
      () => new Response("", { status: 412 }),
      () => listIndexResponse([listRow("rd_a"), listRow("rd_new")], "v2"),
      () => new Response("", { status: 200 }),
    ];
    let i = 0;
    const fetchFn = vi.fn<(input: any, init?: any) => Promise<Response>>(async () =>
      responses[i++]!(),
    );

    await adapter(fetchFn as FetchStub).mergeListRows(
      [{ id: "rd_a", similarity: snapshot }],
      GLOBAL,
    );

    expect(fetchFn).toHaveBeenCalledTimes(4);
    const second = fetchFn.mock.calls[3]![0] as Request;
    expect(second.headers.get("if-match")).toBe('"v2"');
    const body = JSON.parse(await second.text()) as { items: Array<Record<string, unknown>> };
    // The reading added between the two attempts survives the flush.
    expect(body.items.map((row) => row.id)).toEqual(["rd_a", "rd_new"]);
    expect(body.items[0]!.similarity).toEqual(snapshot);
  });

  it("makes no request when the pass measured nothing", async () => {
    const fetchFn = stub(() => new Response("", { status: 200 }));
    await adapter(fetchFn).mergeListRows([], GLOBAL);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("directNeighboursR2 — over the Cloudflare REST R2 client", () => {
  it("reads a manifest through the REST object endpoint", async () => {
    const fetchFn = stub(() => new Response(JSON.stringify({ id: "rd_a" }), { status: 200 }));
    const r2 = directNeighboursR2({
      r2: (bucket) =>
        makeR2RestClient(
          { accountId: "acct123", apiToken: "cf-token", bucket },
          fetchFn as unknown as typeof fetch,
        ),
      vectorize: (index) =>
        makeVectorizeClient(
          { accountId: "acct123", apiToken: "cf-token", index },
          fetchFn as unknown as typeof fetch,
        ),
    });
    await expect(r2.readManifest("readings/rd_a", TENANT)).resolves.toEqual({ id: "rd_a" });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/r2/buckets/reading-lite-staging/objects/u/usr_1/readings/rd_a/manifest.json",
    );
    expect(init.method).toBe("GET");
  });
});

describe("directNeighboursR2 — client reuse", () => {
  it("builds one R2 client per bucket and one Vectorize client per index+namespace", async () => {
    const fetchFn = stub(() => new Response("{}", { status: 200 }));
    const r2 = vi.fn((bucket: string) =>
      makeR2Client({ ...S3_CONFIG, bucket }, fetchFn as unknown as typeof fetch),
    );
    const vectorize = vi.fn(() => ({ queryById: async () => [] }));
    const direct = directNeighboursR2({ r2, vectorize });

    await direct.readManifest("readings/rd_a", GLOBAL);
    await direct.readManifest("readings/rd_b", GLOBAL);
    await direct.queryByVectorId("idx", "rd_a", 6, undefined);
    await direct.queryByVectorId("idx", "rd_b", 6, undefined);
    await direct.queryByVectorId("idx", "rd_c", 6, "usr_1");

    expect(r2).toHaveBeenCalledTimes(1);
    // "idx" un-namespaced and "idx" in usr_1 are different clients.
    expect(vectorize).toHaveBeenCalledTimes(2);
  });
});
