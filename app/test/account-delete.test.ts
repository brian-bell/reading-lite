import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountDeleteFromResponse } from "../src/account-delete";
import { deleteAccount } from "../src/api/account";
import { CSRF_HEADER } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { whoamiQueryKey, type Identity } from "../src/identity";

// Response mapping and request shape for DELETE /api/account (#340.8). The
// page's flows are account-page.test.tsx's; a plain 403's re-read is owned by
// the shared forbiddenOrSwitched tests.

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accountDeleteFromResponse", () => {
  it.each([
    [200, { ok: true }, { kind: "deleted" }],
    [403, { error: "recent authentication required" }, { kind: "step-up" }],
    [403, { error: "forbidden" }, { kind: "forbidden" }],
    [403, null, { kind: "forbidden" }],
    [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, { kind: "account-changed", actingTenant: "usr_b" }],
  ])("maps %i %j", (status, body, outcome) => {
    expect(accountDeleteFromResponse(status, body)).toEqual(outcome);
  });

  it.each([
    [401, { error: "unauthorized" }, "unauthorized"],
    [400, { error: "invalid body" }, "invalid body"],
    [503, null, "failed to delete account"],
  ])("throws %i as an ApiError", (status, body, message) => {
    let thrown: unknown;
    try {
      accountDeleteFromResponse(status, body);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({ status, message });
  });
});

describe("deleteAccount", () => {
  it("sends the literal confirmation with CSRF and the tenant pin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, reader);

    await expect(deleteAccount(queryClient, "usr_a")).resolves.toEqual({ kind: "deleted" });

    const request = vi.mocked(fetch).mock.calls[0]![0] as unknown as Request;
    expect(new URL(request.url).pathname).toBe("/api/account");
    expect(request.method).toBe("DELETE");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    expect(request.headers.get("content-type")).toBe("application/json");
    await expect(request.json()).resolves.toEqual({ confirm: "delete" });
  });

  it("does not re-read who is signed in for a step-up refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "recent authentication required" }, { status: 403 })),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, reader);

    await expect(deleteAccount(queryClient, "usr_a")).resolves.toEqual({ kind: "step-up" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
