import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import { CSRF_HEADER } from "../src/api/client";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { reprocessReading } from "../src/api/reprocess";
import { whoamiQueryKey, type Identity } from "../src/identity";

// The browser path for Retry and Reprocess (#410). How forbiddenOrSwitched
// reads every identity is owned by test/save-api.test.ts; here, that a
// reprocess's 403 goes through it.

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

describe("reprocessReading", () => {
  it("posts an empty body, never force, with the cookie, the CSRF token, and the tenant pin", async () => {
    const fetchMock = vi.fn(async (_request: Request) => Response.json({ id: "rd_1", attempt_id: "att_1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, reader);

    await expect(reprocessReading(queryClient, "rd_1", "usr_a")).resolves.toEqual({ kind: "started" });

    const request = fetchMock.mock.calls[0]![0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/readings/rd_1/reprocess");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({});
  });

  describe("on a 403", () => {
    function answering(whoami: Response) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) =>
          new URL(request.url).pathname === "/api/whoami" ? whoami : Response.json({ error: "forbidden" }, { status: 403 }),
        ),
      );
      const queryClient = new QueryClient();
      queryClient.setQueryData(whoamiQueryKey, reader);
      return queryClient;
    }

    it("is the account-changed refusal when another account is signed in now", async () => {
      const queryClient = answering(Response.json({ ...reader, tenant_id: "usr_b", user_id: "usr_b" }));
      await expect(reprocessReading(queryClient, "rd_1", "usr_a")).resolves.toEqual({
        kind: "account-changed",
        actingTenant: "usr_b",
      });
    });

    it("is the ended session when nobody is signed in now", async () => {
      const queryClient = answering(Response.json({ error: "unauthorized" }, { status: 401 }));
      await expect(reprocessReading(queryClient, "rd_1", "usr_a")).rejects.toEqual(expect.objectContaining({ status: 401 }) as ApiError);
    });
  });
});
