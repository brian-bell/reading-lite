import { describe, expect, it } from "vitest";
import { getRouter } from "../src/router";

// ADR 0003: each server render creates its own QueryClient. Start calls
// getRouter once per request, so the client must be created inside it.
describe("getRouter", () => {
  it("creates a fresh QueryClient for every router", () => {
    const a = getRouter();
    const b = getRouter();
    expect(a.options.context.queryClient).toBeDefined();
    expect(a.options.context.queryClient).not.toBe(b.options.context.queryClient);
  });

  it("dehydrates only its own QueryClient and hydrates into a fresh one", async () => {
    const server = getRouter();
    server.options.context.queryClient.setQueryData(["whoami"], { email: "a@example.com" });
    getRouter().options.context.queryClient.setQueryData(["whoami"], { email: "b@example.com" });

    const dehydrated = await server.options.dehydrate!();
    expect(JSON.stringify(dehydrated)).toContain("a@example.com");
    expect(JSON.stringify(dehydrated)).not.toContain("b@example.com");

    const browser = getRouter();
    await browser.options.hydrate!(dehydrated);
    expect(browser.options.context.queryClient.getQueryData(["whoami"])).toEqual({ email: "a@example.com" });
  });
});
