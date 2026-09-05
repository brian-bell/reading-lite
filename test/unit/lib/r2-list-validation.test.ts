import { describe, expect, it, vi } from "vitest";
import { makeR2Client, makeR2RestClient } from "../../../scripts/lib/cf-clients";

const cfg = { accountId: "test", bucket: "test", accessKeyId: "test", secretAccessKey: "test", apiToken: "test" };
const object = { key: "a&b", size: 0, etag: "abc" };
const contents = '<Contents><Key>a&amp;b</Key><Size>0</Size><ETag>&quot;abc&quot;</ETag></Contents>';
const xml = (body: string) => `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</ListBucketResult>`;
const json = (extra = {}) => ({ success: true, result: [object], result_info: { is_truncated: false }, ...extra });

for (const provider of ["S3", "REST"] as const) {
  const page = (token?: string | null) => provider === "S3"
    ? new Response(xml(`${contents}<IsTruncated>${token !== undefined}</IsTruncated>${token == null ? "" : `<NextContinuationToken>${token}</NextContinuationToken>`}`))
    : Response.json(json({ result_info: { is_truncated: token !== undefined, cursor: token } }));
  const client = (send: typeof fetch) => provider === "S3" ? makeR2Client(cfg, send) : makeR2RestClient(cfg, send, { sleep: async () => {} });
  describe(`${provider} inventory validation`, () => {
    it("preserves empty inventories and zero-byte metadata", async () => {
      const send = vi.fn().mockResolvedValueOnce(provider === "S3" ? new Response(xml('<IsTruncated>false</IsTruncated>')) : Response.json(json({ result: [] }))).mockResolvedValueOnce(page());
      const r2 = client(send);
      await expect(r2.listObjects()).resolves.toEqual([]);
      await expect(r2.listObjects()).resolves.toEqual([object]);
    });
    it("follows usable tokens and resets cursor history for each invocation", async () => {
      const send = vi.fn().mockImplementation(async () => page(send.mock.calls.length % 2 ? "next" : undefined));
      const r2 = client(send);
      for (let i = 0; i < 2; i++) await expect(r2.listKeys()).resolves.toEqual([object.key, object.key]);
      expect(send).toHaveBeenCalledTimes(4);
    });
    it.each([null, "", "   "])("rejects a truncated page with unusable token %j", async (token) => {
      await expect(client(vi.fn().mockResolvedValue(page(token))).listKeys()).rejects.toThrow(/R2 LIST/);
    });
    it.each([["a", "a"], ["a", "b", "a"]])("rejects cyclic tokens %j", async (...tokens) => {
      const send = vi.fn();
      for (const token of tokens) send.mockResolvedValueOnce(page(token));
      send.mockResolvedValueOnce(page()); // A buggy loop must fail the assertion, not hang.
      await expect(client(send).listObjects()).rejects.toThrow(/cursor|token/);
      expect(send).toHaveBeenCalledTimes(tokens.length);
    });
    it("propagates provider errors even if an HTTP failure claims success", async () => {
      const send = vi.fn().mockResolvedValue(new Response(JSON.stringify(json()), { status: 403 }));
      await expect(client(send).listObjects()).rejects.toThrow(/R2 LIST/);
    });
  });
}

it.each([
  '', '<Error/>', xml(''), xml('<IsTruncated>yes</IsTruncated>'),
  xml('<IsTruncated>false</IsTruncated><IsTruncated>true</IsTruncated>'),
  xml('<IsTruncated>false</IsTruncated><Contents>'),
  xml('<IsTruncated>false</IsTruncated><Contents/>'),
  ...['<Key/>', '<Key>a</Key>', '<Key>a</Key><Size>-1</Size><ETag>x</ETag>', '<Key>a</Key><Size>NaN</Size><ETag>x</ETag>', '<Key>a</Key><Size>0</Size><ETag/>', '<Key>a</Key><Key>b</Key><Size>0</Size><ETag>x</ETag>', '<Key>a&bogus;</Key><Size>0</Size><ETag>x</ETag>'].map((item) => xml(`<IsTruncated>false</IsTruncated><Contents>${item}</Contents>`)),
])("rejects malformed S3 success %j", async (body) => {
  await expect(makeR2Client(cfg, vi.fn().mockResolvedValue(new Response(body))).listObjects()).rejects.toThrow(/R2 LIST/);
});
it.each([
  null, {}, json({ success: undefined }), json({ success: false }), json({ result: undefined }), json({ result: {} }), json({ result_info: undefined }), json({ result_info: {} }), json({ result_info: { is_truncated: "false" } }),
  ...[null, {}, { ...object, key: "" }, { ...object, size: undefined }, { ...object, size: null }, { ...object, size: "" }, { ...object, size: -1 }, { ...object, size: 0.5 }, { ...object, etag: undefined }, { ...object, uploaded: 1 }].map((item) => json({ result: [object, item] })),
])("rejects malformed REST success %j", async (body) => {
  await expect(makeR2RestClient(cfg, vi.fn().mockResolvedValue(Response.json(body))).listObjects()).rejects.toThrow(/R2 LIST/);
});

it("accepts S3 numeric entities, self-closing optional fields and object timestamps", async () => {
  const body = xml('<IsTruncated>false</IsTruncated><Prefix/><Contents><Key>a&#38;b&#x2f;c</Key><Size>0</Size><ETag>abc</ETag><LastModified>2026-09-05T00:00:00Z</LastModified></Contents>');
  await expect(makeR2Client(cfg, vi.fn().mockResolvedValue(new Response(body))).listObjects()).resolves.toEqual([
    { key: "a&b/c", size: 0, etag: "abc", lastModified: "2026-09-05T00:00:00Z" },
  ]);
});
it("rejects nested inventory in an unexpected S3 wrapper", async () => {
  await expect(makeR2Client(cfg, vi.fn().mockResolvedValue(new Response(xml(`<IsTruncated>false</IsTruncated><Unexpected>${contents}</Unexpected>`)))).listObjects()).rejects.toThrow(/R2 LIST/);
});
it("rejects invalid JSON with a listing diagnostic", async () => {
  await expect(makeR2RestClient(cfg, vi.fn().mockResolvedValue(new Response("not json"))).listObjects()).rejects.toThrow(/R2 LIST/);
});
it("preserves REST listing throttling retries and provider diagnostics", async () => {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValueOnce(new Response("throttled", { status: 429, headers: { "Retry-After": "1" } }))
    .mockResolvedValueOnce(Response.json(json({ result: [] })))
    .mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: "access denied" }] }));
  const r2 = makeR2RestClient(cfg, send, { sleep });
  await expect(r2.listObjects()).resolves.toEqual([]);
  expect(sleep).toHaveBeenCalledWith(1000);
  await expect(r2.listObjects()).rejects.toThrow(/access denied/);
});

describe("S3 declared page counts", () => {
  it.each([
    { count: "1", entries: "" },
    { count: "0", entries: contents },
    { count: "2", entries: contents },
    ...["", "-1", "1.5", "NaN", "9007199254740992"].map((count) => ({ count, entries: contents })),
  ])("rejects inconsistent or invalid KeyCount=$count", async ({ count, entries }) => {
    const body = xml(`<IsTruncated>false</IsTruncated><KeyCount>${count}</KeyCount>${entries}`);
    await expect(makeR2Client(cfg, vi.fn().mockResolvedValue(new Response(body))).listObjects()).rejects.toThrow(/R2 LIST/);
  });
  it.each([0, 1])("accepts a matching KeyCount=%i", async (count) => {
    const body = xml(`<IsTruncated>false</IsTruncated><KeyCount>${count}</KeyCount>${count ? contents : ""}`);
    await expect(makeR2Client(cfg, vi.fn().mockResolvedValue(new Response(body))).listObjects()).resolves.toEqual(count ? [object] : []);
  });
  it("rejects duplicate count fields", async () => {
    const body = xml('<IsTruncated>false</IsTruncated><KeyCount>0</KeyCount><KeyCount>0</KeyCount>');
    await expect(makeR2Client(cfg, vi.fn().mockResolvedValue(new Response(body))).listObjects()).rejects.toThrow(/R2 LIST/);
  });
});
