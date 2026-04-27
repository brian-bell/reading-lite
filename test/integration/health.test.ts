import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

describe("GET /health", () => {
  it("returns 200 ok without auth", async () => {
    const request = new Request("http://localhost/health");
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
