import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { RECENT_AUTH_WINDOW_MS } from "../../../src/control-plane/constants";
import { createApiTokenPrincipal, createSessionPrincipal } from "../../../src/control-plane/principal";
import { isRecentAuth, principalHasRecentAuth } from "../../../src/control-plane/recent-auth";
import { requireRecentAuth, type AppBindings } from "../../../src/middleware";

const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const SESSION = "ses_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";

const sessionPrincipal = createSessionPrincipal({
  tenantId: USER,
  userId: USER,
  sessionId: SESSION,
  authenticatedAtMs: NOW_MS,
});

const tokenPrincipal = createApiTokenPrincipal({
  tenantId: USER,
  userId: USER,
  tokenId: TOKEN,
  scopes: ["readings:read"],
});

describe("isRecentAuth", () => {
  it("accepts the inclusive 10-minute window and rejects older or future timestamps", () => {
    expect(isRecentAuth(NOW_MS, NOW_MS)).toBe(true);
    expect(isRecentAuth(NOW_MS, NOW_MS + RECENT_AUTH_WINDOW_MS)).toBe(true);
    expect(isRecentAuth(NOW_MS, NOW_MS + RECENT_AUTH_WINDOW_MS + 1)).toBe(false);
    expect(isRecentAuth(NOW_MS + 1, NOW_MS)).toBe(false);
  });
});

describe("principalHasRecentAuth", () => {
  it("is session-only", () => {
    expect(principalHasRecentAuth(sessionPrincipal, NOW_MS)).toBe(true);
    expect(principalHasRecentAuth(tokenPrincipal, NOW_MS)).toBe(false);
    expect(principalHasRecentAuth(undefined, NOW_MS)).toBe(false);
  });
});

describe("requireRecentAuth", () => {
  function appWith(principal: typeof sessionPrincipal | typeof tokenPrincipal, nowMs: number) {
    const app = new Hono<AppBindings>();
    app.use("/sensitive", async (c, next) => {
      c.set("principal", principal);
      await next();
    });
    app.use("/sensitive", requireRecentAuth(() => nowMs));
    app.post("/sensitive", (c) => c.json({ ok: true }));
    return app;
  }

  it("allows a fresh session and rejects a stale session or bearer", async () => {
    const fresh = await appWith(sessionPrincipal, NOW_MS).request("/sensitive", { method: "POST" });
    expect(fresh.status).toBe(200);

    const stale = await appWith(sessionPrincipal, NOW_MS + RECENT_AUTH_WINDOW_MS + 1).request(
      "/sensitive",
      { method: "POST" },
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "recent authentication required" });
    expect(stale.headers.get("cache-control")).toBe("no-store");

    const bearer = await appWith(tokenPrincipal, NOW_MS).request("/sensitive", { method: "POST" });
    expect(bearer.status).toBe(403);
    expect(await bearer.json()).toEqual({ error: "recent authentication required" });
  });
});
