import { describe, expect, it, vi } from "vitest";
import {
  apiBaseFromEndpoint,
  decodeIntakeResponse,
  readingApiFor,
} from "../../../scripts/lib/reading-api";
import { EXPECTED_TENANT_HEADER } from "../../../src/schemas/api";

describe("apiBaseFromEndpoint", () => {
  it("strips a trailing /api/readings endpoint path down to the API base", () => {
    expect(apiBaseFromEndpoint("http://127.0.0.1:8787/api/readings")).toBe("http://127.0.0.1:8787");
    expect(apiBaseFromEndpoint("https://reading-lite.bbell.dev/api/readings/")).toBe(
      "https://reading-lite.bbell.dev",
    );
    expect(apiBaseFromEndpoint("https://x.test/api/readings/import-markdown")).toBe(
      "https://x.test",
    );
  });

  it("leaves a bare base (no endpoint suffix) unchanged apart from trailing slashes", () => {
    expect(apiBaseFromEndpoint("https://x.test/")).toBe("https://x.test");
    expect(apiBaseFromEndpoint("https://x.test")).toBe("https://x.test");
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiWith(fetchMock: typeof fetch) {
  return readingApiFor({
    base: "https://api.example",
    token: "tok-abc",
    fetch: fetchMock,
    sleep: async () => {},
  });
}

// A minimal valid Manifest — what a 200 submit/import response body carries.
const MANIFEST = {
  id: "rd_owner",
  url: "https://example.test/article",
  url_hash: "a".repeat(64),
  status: "ready",
  content_type: "text/html",
  content_status: "captured",
  content_bytes: 10,
  content_sha256: "b".repeat(64),
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:05:00.000Z",
};

describe("decodeIntakeResponse", () => {
  it("decodes a 202 into activated with the reading and attempt ids", () => {
    expect(
      decodeIntakeResponse(202, {
        id: "rd_1",
        status: "pending",
        poll: "/api/readings/rd_1",
        attempt_id: "at_1",
      }),
    ).toEqual({ kind: "activated", id: "rd_1", attemptId: "at_1" });
  });

  it("decodes a 200 manifest body into existing, carrying the parsed manifest", () => {
    const out = decodeIntakeResponse(200, MANIFEST);
    expect(out.kind).toBe("existing");
    if (out.kind !== "existing") return;
    expect(out.id).toBe("rd_owner");
    expect(out.manifest?.status).toBe("ready");
  });

  it("decodes a 200 id-only body (lookup) into existing without a manifest", () => {
    expect(decodeIntakeResponse(200, { id: "rd_9" })).toEqual({
      kind: "existing",
      id: "rd_9",
    });
  });

  it("decodes a 409 that carries an id into initializing (poll the id)", () => {
    expect(
      decodeIntakeResponse(409, {
        error: "reading owner is still initializing",
        id: "rd_2",
        poll: "/api/readings/rd_2",
      }),
    ).toEqual({ kind: "initializing", id: "rd_2" });
  });

  it("decodes a 409 without an id into conflict, naming the wire reason", () => {
    expect(
      decodeIntakeResponse(409, { error: "reading already has an active attempt" }),
    ).toEqual({
      kind: "conflict",
      reason: "active_attempt",
      message: "reading already has an active attempt",
    });
    expect(decodeIntakeResponse(409, { error: "markdown content not available" })).toEqual({
      kind: "conflict",
      reason: "missing_markdown",
      message: "markdown content not available",
    });
    expect(decodeIntakeResponse(409, { error: "something new" })).toEqual({
      kind: "conflict",
      reason: "unknown",
      message: "something new",
    });
  });

  it("treats a 200 without an id as http_error — every valid 200 wire shape carries one", () => {
    expect(decodeIntakeResponse(200, {})).toEqual({
      kind: "http_error",
      status: 200,
      message: "200 response did not include an id",
    });
  });

  it("decodes a 404 into not_found", () => {
    expect(decodeIntakeResponse(404, { error: "not found" })).toEqual({ kind: "not_found" });
  });

  it("decodes a 503 into unavailable with the retryable reason message", () => {
    expect(
      decodeIntakeResponse(503, { error: "queue send failed", id: "rd_3" }),
    ).toEqual({ kind: "unavailable", message: "queue send failed", id: "rd_3" });
  });

  it("decodes a 429 quota denial into quota with reset_at", () => {
    expect(
      decodeIntakeResponse(429, {
        error: "monthly reading quota exceeded",
        code: "quota_exhausted",
        limit: "monthly",
        reset_at: "2026-10-01T00:00:00.000Z",
      }),
    ).toEqual({
      kind: "quota",
      code: "quota_exhausted",
      limit: "monthly",
      resetAt: "2026-10-01T00:00:00.000Z",
      message: "monthly reading quota exceeded",
    });
  });

  it("decodes any other status into http_error carrying status and message", () => {
    expect(decodeIntakeResponse(500, { error: "internal" })).toEqual({
      kind: "http_error",
      status: 500,
      message: "internal",
    });
    expect(decodeIntakeResponse(401, "unauthorized")).toEqual({
      kind: "http_error",
      status: 401,
      message: "unauthorized",
    });
  });

  it("treats a 202 without an id as http_error rather than fabricating an activation", () => {
    expect(decodeIntakeResponse(202, {})).toEqual({
      kind: "http_error",
      status: 202,
      message: "202 response did not include an id",
    });
  });
});

describe("readingApiFor", () => {
  it("keeps concurrent clients' bearer credentials and tenant pins separate for the same URL and id", async () => {
    const principals = [
      { tenant: "usr_11111111-1111-4111-8111-111111111111", token: "token-A", title: "A's reading" },
      { tenant: "usr_22222222-2222-4222-8222-222222222222", token: "token-B", title: "B's reading" },
    ];
    const submissions = new Map(principals.map((p) => [p.token, 0]));
    const server = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const principal = principals.find((p) => headers.get("authorization") === `Bearer ${p.token}`);
      if (!principal || headers.get(EXPECTED_TENANT_HEADER) !== principal.tenant) return jsonResponse(403, { error: "forbidden" });
      if (init?.method === "POST") submissions.set(principal.token, submissions.get(principal.token)! + 1);
      return jsonResponse(200, { ...MANIFEST, title: principal.title });
    });
    const clients = principals.map((p) => readingApiFor({
      base: "https://api.example", token: p.token, expectedTenant: p.tenant, fetch: server,
    }));
    const writes = await Promise.all(clients.map((api) => api.submit(MANIFEST.url)));
    const reads = await Promise.all(clients.map((api) => api.getReading(MANIFEST.id)));
    for (const [i, principal] of principals.entries()) {
      expect(writes[i]).toMatchObject({ kind: "existing", manifest: { id: MANIFEST.id, title: principal.title } });
      expect(reads[i]).toMatchObject({ kind: "manifest", manifest: { id: MANIFEST.id, title: principal.title } });
      expect(submissions.get(principal.token)).toBe(1);
    }
  });

  it("submit POSTs the url with bearer auth and returns the decoded outcome", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(202, { id: "rd_1", status: "pending", attempt_id: "at_1" }),
    );
    const out = await apiWith(fetchMock).submit("https://x.test/", { email: false });
    expect(out).toEqual({ kind: "activated", id: "rd_1", attemptId: "at_1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example/api/readings");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://x.test/", email: false });
  });

  it("submit omits the email field when the caller does not decide it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(202, { id: "rd_1", status: "pending" }),
    );
    await apiWith(fetchMock).submit("https://x.test/");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://x.test/" });
  });

  it("submit retries a transport throw and recovers when a later attempt succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return jsonResponse(202, { id: "rd_1", status: "pending" });
    });
    const out = await apiWith(fetchMock).submit("https://x.test/");
    expect(out.kind).toBe("activated");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("submit reports transport_error with the unwrapped cause chain after exhausting retries", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const inner = Object.assign(new Error("Other side closed"), { code: "UND_ERR_SOCKET" });
      throw Object.assign(new TypeError("fetch failed"), { cause: inner });
    });
    const out = await apiWith(fetchMock).submit("https://x.test/");
    expect(out).toEqual({
      kind: "transport_error",
      message: "fetch failed / UND_ERR_SOCKET: Other side closed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("submit retries when the response body stream fails mid-read (a transport failure)", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls < 2) {
        return {
          status: 202,
          text: async () => {
            throw new TypeError("terminated");
          },
        } as unknown as Response;
      }
      return jsonResponse(202, { id: "rd_1", status: "pending" });
    });
    const out = await apiWith(fetchMock).submit("https://x.test/");
    expect(out.kind).toBe("activated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("submit does not retry an HTTP error status (that is the worker speaking)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(503, { error: "down" }));
    const out = await apiWith(fetchMock).submit("https://x.test/");
    expect(out).toEqual({ kind: "unavailable", message: "down" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("submit rejects an id-only 200 because intake writes must return a valid manifest", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { id: "rd_owner" }));

    await expect(apiWith(fetchMock).submit("https://x.test/")).resolves.toEqual({
      kind: "http_error",
      status: 200,
      message: "200 response was not a valid manifest",
    });
  });

  it("reprocess POSTs force and encodes the id into the path", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(202, { id: "rd_1", status: "pending", attempt_id: "at_2" }),
    );
    const out = await apiWith(fetchMock).reprocess("rd_1", { force: true, email: false });
    expect(out).toEqual({ kind: "activated", id: "rd_1", attemptId: "at_2" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example/api/readings/rd_1/reprocess");
    expect(JSON.parse(String(init?.body))).toEqual({ force: true, email: false });
  });

  it("reprocess never retries a transport throw — a delivered retry would double-bill", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const out = await apiWith(fetchMock).reprocess("rd_1", { force: true });
    expect(out).toEqual({ kind: "transport_error", message: "fetch failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("importMarkdown POSTs the import body and retries transport throws", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(202, { id: "rd_5", status: "pending" });
    });
    const out = await apiWith(fetchMock).importMarkdown({
      source_url: "https://x.test/",
      markdown: "# hi",
      title: "Hi",
      email: false,
    });
    expect(out).toEqual({ kind: "activated", id: "rd_5" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://api.example/api/readings/import-markdown");
    expect(JSON.parse(String(init?.body))).toEqual({
      source_url: "https://x.test/",
      markdown: "# hi",
      title: "Hi",
      email: false,
    });
  });

  it("importMarkdown rejects an id-only 200 because intake writes must return a valid manifest", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { id: "rd_owner" }));

    await expect(
      apiWith(fetchMock).importMarkdown({
        source_url: "https://x.test/",
        markdown: "# hi",
      }),
    ).resolves.toEqual({
      kind: "http_error",
      status: 200,
      message: "200 response was not a valid manifest",
    });
  });

  it("lookup GETs with the url encoded and decodes owner responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { id: "rd_1" }));
    const out = await apiWith(fetchMock).lookup("https://youtu.be/abc?t=30");
    expect(out).toEqual({ kind: "existing", id: "rd_1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://api.example/api/readings/lookup?url=https%3A%2F%2Fyoutu.be%2Fabc%3Ft%3D30",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok-abc");
  });

  it("lookup decodes a 404 into not_found and a 409 owner into initializing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: "not found" }))
      .mockResolvedValueOnce(
        jsonResponse(409, { error: "reading owner is still initializing", id: "rd_2" }),
      );
    const api = apiWith(fetchMock);
    expect(await api.lookup("https://a.test/")).toEqual({ kind: "not_found" });
    expect(await api.lookup("https://b.test/")).toEqual({ kind: "initializing", id: "rd_2" });
  });

  it("getReading parses the manifest behind GET /api/readings/:id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, MANIFEST));
    const out = await apiWith(fetchMock).getReading("rd_owner");
    expect(out.kind).toBe("manifest");
    if (out.kind !== "manifest") return;
    expect(out.manifest.id).toBe("rd_owner");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example/api/readings/rd_owner");
  });
});

describe("waitTerminal", () => {
  function timedApi(fetchMock: typeof fetch) {
    let clock = 0;
    return readingApiFor({
      base: "https://api.example",
      token: "tok",
      fetch: fetchMock,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
  }

  it("polls until the manifest reaches a terminal status", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ...MANIFEST, status: "pending" }))
      .mockResolvedValueOnce(jsonResponse(200, { ...MANIFEST, status: "pending" }))
      .mockResolvedValueOnce(jsonResponse(200, { ...MANIFEST, status: "ready" }));
    const out = await timedApi(fetchMock).waitTerminal("rd_owner", {
      pollMs: 100,
      timeoutMs: 10_000,
    });
    expect(out.kind).toBe("ready");
    if (out.kind !== "ready") return;
    expect(out.manifest.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns the failed manifest when the reading lands failed", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { ...MANIFEST, status: "failed" }),
    );
    const out = await timedApi(fetchMock).waitTerminal("rd_owner", {
      pollMs: 100,
      timeoutMs: 10_000,
    });
    expect(out.kind).toBe("failed");
  });

  it("tolerates a transient non-200 mid-poll and keeps polling", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(200, { ...MANIFEST, status: "ready" }));
    const out = await timedApi(fetchMock).waitTerminal("rd_owner", {
      pollMs: 100,
      timeoutMs: 10_000,
    });
    expect(out.kind).toBe("ready");
  });

  it("gives up with timeout when the reading never becomes terminal", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { ...MANIFEST, status: "pending" }),
    );
    const out = await timedApi(fetchMock).waitTerminal("rd_owner", {
      pollMs: 1_000,
      timeoutMs: 3_500,
    });
    expect(out).toEqual({ kind: "timeout" });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
