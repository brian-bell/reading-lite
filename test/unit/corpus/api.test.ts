import { describe, expect, it, vi } from "vitest";
import { lookupReading } from "../../../scripts/corpus-lib/api";

const deps = (fetch: typeof globalThis.fetch) => ({
  base: "https://api.example",
  token: "t",
  fetch,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("lookupReading", () => {
  it("authenticates and url-encodes the lookup query", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { id: "rd_1" })) as unknown as typeof globalThis.fetch;
    await lookupReading("https://youtu.be/abc?t=30", deps(fetch));
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(
      "https://api.example/readings/lookup?url=https%3A%2F%2Fyoutu.be%2Fabc%3Ft%3D30",
    );
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer t" });
  });

  it("reports found with the reading id on a 200", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { id: "rd_1" })) as unknown as typeof globalThis.fetch;
    expect(await lookupReading("https://x", deps(fetch))).toEqual({ found: true, id: "rd_1" });
  });

  it("reports not found on a 404", async () => {
    const fetch = vi.fn(async () => jsonResponse(404, { error: "not found" })) as unknown as typeof globalThis.fetch;
    expect(await lookupReading("https://x", deps(fetch))).toEqual({ found: false });
  });

  it("surfaces an error string on an unexpected status", async () => {
    const fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch;
    const res = await lookupReading("https://x", deps(fetch));
    expect(res.found).toBe(false);
    expect(res.error).toContain("500");
  });
});
