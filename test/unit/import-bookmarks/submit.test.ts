import { describe, expect, it, vi } from "vitest";
import { submitAll, type SubmitResult } from "../../../scripts/import-bookmarks-lib/submit";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("submitAll", () => {
  it("classifies 202/200/4xx and skips non-http schemes", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(202, { id: "rd_new", status: "pending" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "rd_old", status: "ready" }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));

    const results: SubmitResult[] = [];
    const summary = await submitAll(
      [
        "https://new.test/",
        "https://old.test/",
        "https://broken.test/",
        "chrome://settings",
        "javascript:void(0)",
      ],
      {
        fetch: fetchMock,
        base: "http://localhost:8787",
        token: "tok",
        concurrency: 2,
        onResult: async (r) => {
          results.push(r);
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ new: 1, existing: 1, errors: 1, skipped: 2 });

    const byUrl = Object.fromEntries(results.map((r) => [r.url, r]));
    expect(byUrl["https://new.test/"]!.classification).toBe("new");
    expect(byUrl["https://new.test/"]!.id).toBe("rd_new");
    expect(byUrl["https://old.test/"]!.classification).toBe("existing");
    expect(byUrl["https://old.test/"]!.id).toBe("rd_old");
    expect(byUrl["https://broken.test/"]!.classification).toBe("error");
    expect(byUrl["https://broken.test/"]!.error).toMatch(/500/);
    expect(byUrl["chrome://settings"]!.classification).toBe("skipped");
    expect(byUrl["javascript:void(0)"]!.classification).toBe("skipped");
  });

  it("classifies network errors as 'error'", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network down");
    });
    const results: SubmitResult[] = [];
    const summary = await submitAll(["https://x.test/"], {
      fetch: fetchMock,
      base: "http://localhost:8787",
      token: "tok",
      concurrency: 1,
      onResult: async (r) => {
        results.push(r);
      },
    });
    expect(summary.errors).toBe(1);
    expect(results[0]!.classification).toBe("error");
    expect(results[0]!.error).toMatch(/network down/);
  });

  it("sends bearer auth and a JSON body to /readings", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(202, { id: "rd_x", status: "pending" }),
    );
    await submitAll(["https://x.test/"], {
      fetch: fetchMock,
      base: "http://localhost:8787",
      token: "tok-abc",
      concurrency: 1,
      onResult: async () => {},
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:8787/readings");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-abc");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://x.test/" });
  });

  it("strips a trailing slash from base before joining /readings", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(202, { id: "rd_x", status: "pending" }),
    );
    await submitAll(["https://x.test/"], {
      fetch: fetchMock,
      base: "http://localhost:8787/",
      token: "tok",
      concurrency: 1,
      onResult: async () => {},
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:8787/readings");
  });

  it("respects the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return jsonResponse(202, { id: "rd_x", status: "pending" });
    });
    await submitAll(
      Array.from({ length: 10 }, (_, i) => `https://${i}.test/`),
      {
        fetch: fetchMock,
        base: "http://localhost:8787",
        token: "tok",
        concurrency: 3,
        onResult: async () => {},
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("calls onResult once per URL with index/total set", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(202, { id: "rd_x", status: "pending" }),
    );
    const indices: number[] = [];
    const totals: number[] = [];
    await submitAll(["https://a.test/", "https://b.test/", "https://c.test/"], {
      fetch: fetchMock,
      base: "http://localhost:8787",
      token: "tok",
      concurrency: 1,
      onResult: async (r) => {
        indices.push(r.index);
        totals.push(r.total);
      },
    });
    expect(indices.sort()).toEqual([1, 2, 3]);
    expect(totals).toEqual([3, 3, 3]);
  });
});
