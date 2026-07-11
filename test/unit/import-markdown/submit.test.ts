import { describe, expect, it, vi } from "vitest";
import {
  submitMarkdownAll,
  type MarkdownSubmitResult,
} from "../../../scripts/import-markdown-lib/submit";

const DEST = "http://localhost:8787/api/readings/import-markdown";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("submitMarkdownAll", () => {
  it("POSTs markdown import payloads serially", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return jsonResponse(202, { id: "rd_x", status: "pending" });
    });

    const results: MarkdownSubmitResult[] = [];
    const summary = await submitMarkdownAll(
      [
        {
          sourceUrl: "https://example.com/a",
          title: "A",
          markdown: "# A\n\nbody",
          filePath: "/tmp/a.md",
        },
        {
          sourceUrl: "https://example.com/b",
          markdown: "# B\n\nbody",
          filePath: "/tmp/b.md",
        },
      ],
      {
        fetch: fetchMock,
        destinationUrl: DEST,
        token: "tok",
        email: false,
        onResult: (result) => {
          results.push(result);
        },
      },
    );

    expect(summary).toMatchObject({ total: 2, new: 2, existing: 0, errors: 0 });
    expect(peak).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.classification)).toEqual(["new", "new"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(DEST);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      source_url: "https://example.com/a",
      title: "A",
      markdown: "# A\n\nbody",
      email: false,
    });
  });

  it("classifies existing and error responses", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { id: "rd_old", status: "ready" }))
      .mockResolvedValueOnce(jsonResponse(400, { error: "bad body" }));

    const results: MarkdownSubmitResult[] = [];
    const summary = await submitMarkdownAll(
      [
        {
          sourceUrl: "https://example.com/old",
          markdown: "# Old",
          filePath: "/tmp/old.md",
        },
        {
          sourceUrl: "https://example.com/bad",
          markdown: "# Bad",
          filePath: "/tmp/bad.md",
        },
      ],
      {
        fetch: fetchMock,
        destinationUrl: DEST,
        token: "tok",
        email: true,
        onResult: (result) => {
          results.push(result);
        },
      },
    );

    expect(summary).toMatchObject({ existing: 1, errors: 1 });
    expect(results[0]).toMatchObject({ classification: "existing", id: "rd_old" });
    expect(results[1]).toMatchObject({ classification: "error" });
    expect(results[1]!.error).toMatch(/400/);
  });

  it("retries transport errors and surfaces failure after exhausting retries", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network down");
    });
    const results: MarkdownSubmitResult[] = [];

    const summary = await submitMarkdownAll(
      [
        {
          sourceUrl: "https://example.com/a",
          markdown: "# A",
          filePath: "/tmp/a.md",
        },
      ],
      {
        fetch: fetchMock,
        destinationUrl: DEST,
        token: "tok",
        email: false,
        onResult: (result) => {
          results.push(result);
        },
      },
    );

    expect(summary.errors).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results[0]!.error).toMatch(/network down/);
  });
});
