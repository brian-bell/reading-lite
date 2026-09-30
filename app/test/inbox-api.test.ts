import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { discardInboxItem, fetchInbox, fetchInboxItem, promoteInboxItem } from "../src/api/inbox";
import { EXPECTED_TENANT_HEADER } from "../src/api/readings";
import { whoamiQueryKey, type Identity } from "../src/identity";

// The browser path for the inbox (reading-lite-fy8t): same-origin /api/inbox
// with the session cookie and the tenant pin, and the CSRF token on writes.
// What each answer means is test/inbox.test.ts's.

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

function stubFetch(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

function lastRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as unknown as Request;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inbox requests", () => {
  it.each([
    ["the list", () => fetchInbox(signedIn(), "usr_a"), "/api/inbox", Response.json({ items: [] })],
    [
      "an item",
      () => fetchInboxItem(signedIn(), "in_1", "usr_a"),
      "/api/inbox/in_1",
      Response.json({ error: "not found" }, { status: 404 }),
    ],
  ])("reads %s with the cookie and the tenant pin", async (_name, call, path, response) => {
    stubFetch(response);
    await call();

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe(path);
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    expect(request.headers.get(CSRF_HEADER)).toBeNull();
  });

  it("promotes with an empty JSON body, the CSRF token, and the tenant pin", async () => {
    stubFetch(Response.json({ id: "rd_1", status: "pending", inbox_item_id: "in_1" }, { status: 202 }));
    await expect(promoteInboxItem(signedIn(), "in_1", "usr_a")).resolves.toEqual({ kind: "accepted", id: "rd_1" });

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/inbox/in_1/promote");
    expect(request.method).toBe("POST");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
    // Never `email`: the completion email is the backend's default, off.
    await expect(request.json()).resolves.toEqual({});
  });

  it("discards with the CSRF token and the tenant pin", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(discardInboxItem(signedIn(), "in_1", "usr_a")).resolves.toEqual({ kind: "discarded" });

    const request = lastRequest();
    expect(new URL(request.url).pathname).toBe("/api/inbox/in_1");
    expect(request.method).toBe("DELETE");
    expect(request.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(request.headers.get(EXPECTED_TENANT_HEADER)).toBe("usr_a");
  });

  it("asks who is signed in when a discard is refused, as other writes do", async () => {
    // The refusal, then whoami answering as another reader.
    const fetchMock = vi.fn(async (input: Request) =>
      new URL(input.url).pathname === "/api/whoami"
        ? Response.json({ ...reader, user_id: "usr_b", tenant_id: "usr_b" })
        : Response.json({ error: "forbidden" }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(discardInboxItem(signedIn(), "in_1", "usr_a")).resolves.toEqual({
      kind: "account-changed",
      actingTenant: "usr_b",
    });
  });
});
