import { describe, expect, it, vi } from "vitest";
import { IdentityUnavailableError, identityFromResponse, readWhoamiFromBackend, type Identity } from "../src/identity";
import type { BackendReads } from "../src/server/backend-reads";

const identity: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

describe("identityFromResponse", () => {
  it("returns the identity for 200", () => {
    expect(identityFromResponse(200, identity)).toEqual(identity);
  });

  it("returns null (signed out) only for 401", () => {
    expect(identityFromResponse(401, { error: "unauthorized" })).toBeNull();
  });

  // #369: a 403 is never treated as sign-out.
  it.each([403, 400, 404, 412, 500, 503])("throws for %i instead of signing out", (status) => {
    expect(() => identityFromResponse(status, { error: "x" })).toThrow(IdentityUnavailableError);
  });

  it.each([
    ["null", null],
    ["a string", "a@example.com"],
    ["a missing email", { ...identity, email: undefined }],
    ["an unknown principal", { ...identity, principal: "admin" }],
    ["a non-string csrf token", { ...identity, csrf_token: 1 }],
  ])("throws for a 200 with %s", (_label, body) => {
    expect(() => identityFromResponse(200, body)).toThrow(IdentityUnavailableError);
  });
});

describe("readWhoamiFromBackend", () => {
  function backend(result: { status: number; body: unknown }) {
    const whoami = vi.fn(async () => result);
    const reading = vi.fn(async () => ({ status: 500, body: null }));
    return { binding: { whoami, reading } satisfies BackendReads, whoami };
  }

  it("passes the incoming Cookie header and host to the entrypoint", async () => {
    const { binding, whoami } = backend({ status: 200, body: identity });
    const request = new Request("https://next.readinglite.ai/readings/rd_1", {
      headers: { cookie: "__Host-session=abc; theme=dark", origin: "https://evil.example" },
    });
    await expect(readWhoamiFromBackend(binding, request)).resolves.toEqual(identity);
    expect(whoami).toHaveBeenCalledWith({ cookie: "__Host-session=abc; theme=dark", host: "next.readinglite.ai" });
  });

  it("passes null without a Cookie header and keeps a loopback port", async () => {
    const { binding, whoami } = backend({ status: 401, body: { error: "unauthorized" } });
    await expect(readWhoamiFromBackend(binding, new Request("http://127.0.0.1:5174/"))).resolves.toBeNull();
    expect(whoami).toHaveBeenCalledWith({ cookie: null, host: "127.0.0.1:5174" });
  });

  it("reports an entrypoint failure as unavailable, not signed out", async () => {
    const binding: BackendReads = {
      whoami: async () => {
        throw new Error("binding down");
      },
      reading: async () => ({ status: 500, body: null }),
    };
    await expect(readWhoamiFromBackend(binding, new Request("https://readinglite.ai/"))).rejects.toThrow(
      IdentityUnavailableError,
    );
  });
});
