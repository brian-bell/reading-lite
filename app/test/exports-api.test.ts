import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { fetchLatestExport, requestExport } from "../src/api/exports";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { whoamiQueryKey, type Identity } from "../src/identity";

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

function signedIn(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(whoamiQueryKey, reader);
  return queryClient;
}

function requests(): Request[] {
  return vi.mocked(fetch).mock.calls.map((call) => call[0] as unknown as Request);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLatestExport", () => {
  it("reads the latest export with the session cookie and the tenant pin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ export: null, next_allowed_at: "2026-09-25T00:00:00Z" })));
    await fetchLatestExport(signedIn(), "usr_a");

    const [request] = requests();
    expect(new URL(request!.url).pathname).toBe("/api/exports/latest");
    expect(request!.method).toBe("GET");
    expect(request!.credentials).toBe("include");
    expect(request!.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });
});

describe("requestExport", () => {
  it("posts with CSRF and the tenant pin, and no body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "exp_1", status: "queued" }, { status: 202 })));

    await expect(requestExport(signedIn(), "usr_a")).resolves.toEqual({ kind: "queued", id: "exp_1" });

    const [request] = requests();
    expect(new URL(request!.url).pathname).toBe("/api/exports");
    expect(request!.method).toBe("POST");
    expect(request!.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request!.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    await expect(request!.text()).resolves.toBe("");
  });

  it("reads a 403 as another account when whoami now names someone else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        new URL(request.url).pathname === "/api/whoami"
          ? Response.json({ ...reader, user_id: "usr_b", tenant_id: "usr_b" })
          : Response.json({ error: "forbidden" }, { status: 403 }),
      ),
    );

    await expect(requestExport(signedIn(), "usr_a")).resolves.toEqual({ kind: "account-changed", actingTenant: "usr_b" });
  });
});
