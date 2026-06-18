import { describe, expect, it, vi } from "vitest";
import { fetchListIndex, type Runner } from "../../../scripts/check-corpus-lib/fetch-index";

describe("fetchListIndex", () => {
  it("invokes wrangler r2 object get for the bucket and returns stdout", async () => {
    const run = vi.fn<Runner>(async () => ({ code: 0, stdout: '{"items":[]}', stderr: "" }));
    const out = await fetchListIndex({ bucket: "reading-lite", run });
    expect(out).toBe('{"items":[]}');
    expect(run).toHaveBeenCalledWith("wrangler", [
      "r2",
      "object",
      "get",
      "reading-lite/index/list.json",
      "--pipe",
      "--remote",
    ]);
  });

  it("omits --remote when remote is false", async () => {
    const run = vi.fn<Runner>(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    await fetchListIndex({ bucket: "b", remote: false, run });
    expect(run.mock.calls[0]![1]).not.toContain("--remote");
  });

  it("throws with a login hint when wrangler is not authenticated", async () => {
    const run = vi.fn<Runner>(async () => ({ code: 1, stdout: "", stderr: "Not logged in." }));
    await expect(fetchListIndex({ bucket: "b", run })).rejects.toThrow(/wrangler login/);
  });
});
