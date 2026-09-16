import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { reprocessReading } from "../src/api/reprocess";
import { whoamiQueryKey, type Identity } from "../src/identity";

// The browser path for Retry and Reprocess (#410). A 403's second read is
// forbiddenOrSwitched's, owned by test/save-api.test.ts.

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
});
