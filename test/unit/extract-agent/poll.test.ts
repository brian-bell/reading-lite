import { describe, expect, it, vi } from "vitest";
import { AgentFatalError, pageAllReadings } from "../../../scripts/extract-agent-lib/poll";
import { jsonResponse, makeRow, pageResponse } from "./helpers";

const DEPS = { base: "https://reading.example", token: "tok_test" };

describe("pageAllReadings", () => {
  it("pages until has_more is false, concatenating rows in order", async () => {
    const [a, b, c] = [makeRow(), makeRow(), makeRow()];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pageResponse([a, b], true)))
      .mockResolvedValueOnce(jsonResponse(pageResponse([c], false, 2)));

    const rows = await pageAllReadings({ ...DEPS, fetch });

    expect(rows.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe("https://reading.example/api/readings?offset=0&limit=100");
    // offset advances by the rows actually received — no exactness promise beyond that
    expect(fetch.mock.calls[1]![0]).toBe("https://reading.example/api/readings?offset=2&limit=100");
  });

  it("sends the bearer header on every page", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pageResponse([makeRow()], true)))
      .mockResolvedValueOnce(jsonResponse(pageResponse([], false, 1)));

    await pageAllReadings({ ...DEPS, fetch });

    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toEqual({ authorization: "Bearer tok_test" });
    }
  });

  it("surfaces a non-200 page as a run-fatal error", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));

    await expect(pageAllReadings({ ...DEPS, fetch })).rejects.toThrow(AgentFatalError);
    await expect(
      pageAllReadings({ ...DEPS, fetch }),
    ).rejects.toThrow(/503/);
  });

  it("surfaces a malformed page body as a run-fatal error", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ readings: "not-an-array" }));

    await expect(pageAllReadings({ ...DEPS, fetch })).rejects.toThrow(AgentFatalError);
  });
});
