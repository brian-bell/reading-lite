import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { LOGIN_NEXT_STORAGE_KEY, rememberReturnPath } from "../src/auth/return-path";
import { redirectSignedInFromLogin, requireSignedIn } from "../src/auth/guards";
import {
  completeSignIn,
  createQueryClient,
  sessionEndedQueryKey,
  signOut,
} from "../src/auth/session";
import { whoamiQueryKey, type Identity } from "../src/identity";

const identity: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("createQueryClient", () => {
  async function failWith(queryClient: QueryClient, error: Error) {
    await queryClient
      .fetchQuery({
        queryKey: ["reading", "rd_ONE"],
        queryFn: () => Promise.reject(error),
        retry: false,
      })
      .catch(() => undefined);
  }

  it("marks the session ended at the current URL on a 401 from any query", async () => {
    const queryClient = createQueryClient(() => "/readings/rd_ONE?view=source");
    queryClient.setQueryData(whoamiQueryKey, identity);
    await failWith(queryClient, new ApiError(401, "unauthorized"));
    expect(queryClient.getQueryData(sessionEndedQueryKey)).toBe("/readings/rd_ONE?view=source");
    expect(queryClient.getQueryData(whoamiQueryKey)).toBeNull();
  });

  it("marks the session ended on a 401 from a mutation", async () => {
    const queryClient = createQueryClient(() => "/save");
    queryClient.setQueryData(whoamiQueryKey, identity);
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => Promise.reject(new ApiError(401, "unauthorized")) })
      .execute(undefined)
      .catch(() => undefined);
    expect(queryClient.getQueryData(sessionEndedQueryKey)).toBe("/save");
  });

  it.each([403, 404, 412, 500])("never treats %i as a sign-out", async (status) => {
    const queryClient = createQueryClient(() => "/readings/rd_ONE");
    queryClient.setQueryData(whoamiQueryKey, identity);
    await failWith(queryClient, new ApiError(status, "no"));
    expect(queryClient.getQueryData(sessionEndedQueryKey)).toBeUndefined();
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(identity);
  });
});

describe("signOut", () => {
  function signedIn() {
    const queryClient = createQueryClient(() => "/");
    queryClient.setQueryData(whoamiQueryKey, identity);
    queryClient.setQueryData(["reading", "rd_ONE"], { id: "rd_ONE" });
    queryClient.setQueryData(["login-options"], { turnstile_site_key: null });
    return queryClient;
  }

  it("posts logout with the CSRF token, then forgets the account", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        calls.push(request);
        return Response.json({ ok: true });
      }),
    );
    const queryClient = signedIn();
    await signOut(queryClient);
    expect(calls[0]!.headers.get(CSRF_HEADER)).toBe("csrf-a");
    expect(queryClient.getQueryData(whoamiQueryKey)).toBeNull();
    expect(queryClient.getQueryData(["reading", "rd_ONE"])).toBeUndefined();
    expect(queryClient.getQueryData(["login-options"])).toEqual({ turnstile_site_key: null });
  });

  it.each([401, 500])("forgets the account even when logout returns %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "x" }, { status })),
    );
    const queryClient = signedIn();
    await signOut(queryClient);
    expect(queryClient.getQueryData(whoamiQueryKey)).toBeNull();
    expect(queryClient.getQueryData(["reading", "rd_ONE"])).toBeUndefined();
  });
});

describe("completeSignIn", () => {
  it("replaces the previous account's data with the new identity", async () => {
    const other = { ...identity, email: "b@example.com", tenant_id: "usr_b", user_id: "usr_b", csrf_token: "csrf-b" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(other)),
    );
    const queryClient = createQueryClient(() => "/");
    queryClient.setQueryData(whoamiQueryKey, identity);
    queryClient.setQueryData(["reading", "rd_ONE"], { id: "rd_ONE" });
    queryClient.setQueryData(sessionEndedQueryKey, "/readings/rd_ONE");
    await expect(completeSignIn(queryClient)).resolves.toEqual(other);
    expect(queryClient.getQueryData(whoamiQueryKey)).toEqual(other);
    expect(queryClient.getQueryData(["reading", "rd_ONE"])).toBeUndefined();
    expect(queryClient.getQueryData(sessionEndedQueryKey)).toBeNull();
  });

  it("returns null when the new session is not visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 })),
    );
    await expect(completeSignIn(createQueryClient(() => "/"))).resolves.toBeNull();
  });
});

function thrown(fn: () => Promise<unknown>) {
  return fn().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("requireSignedIn", () => {
  function context(value: Identity | null) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, value);
    return { queryClient };
  }

  it("sends a signed-out direct link to sign-in with a return path", async () => {
    const error = await thrown(() =>
      requireSignedIn({ context: context(null), location: { href: "/readings/rd_ONE?view=source" } }),
    );
    expect(isRedirect(error)).toBe(true);
    expect((error as { options: { href: string } }).options.href).toBe(
      "/login?next=%2Freadings%2Frd_ONE%3Fview%3Dsource",
    );
  });

  it("lets a signed-in reader through", async () => {
    await expect(
      requireSignedIn({ context: context(identity), location: { href: "/readings/rd_ONE" } }),
    ).resolves.toBeUndefined();
  });

  it("does not redirect when identity is unavailable (a 403 is not a sign-out)", async () => {
    const queryClient = new QueryClient();
    const ensure = vi.spyOn(queryClient, "ensureQueryData").mockRejectedValue(new Error("whoami returned 403"));
    await expect(
      requireSignedIn({ context: { queryClient }, location: { href: "/readings/rd_ONE" } }),
    ).resolves.toBeUndefined();
    expect(ensure).toHaveBeenCalled();
  });
});

describe("redirectSignedInFromLogin", () => {
  function context(value: Identity | null) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, value);
    return { queryClient };
  }

  it("sends a signed-in reader to the safe next and clears the stored path", async () => {
    rememberReturnPath("/readings/rd_STALE");
    const error = await thrown(() =>
      redirectSignedInFromLogin({ context: context(identity), search: { next: "/readings/rd_ONE" } }),
    );
    expect((error as { options: { href: string } }).options.href).toBe("/readings/rd_ONE");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY)).toBeNull();
  });

  it("sends a signed-in reader home for an unsafe next", async () => {
    const error = await thrown(() =>
      redirectSignedInFromLogin({ context: context(identity), search: { next: "https://evil.example" } }),
    );
    expect((error as { options: { href: string } }).options.href).toBe("/");
  });

  it("keeps a signed-in reader on /login for step-up", async () => {
    await expect(
      redirectSignedInFromLogin({ context: context(identity), search: { next: "/account/security", step_up: "1" } }),
    ).resolves.toBeUndefined();
  });

  it("shows the form when signed out", async () => {
    await expect(
      redirectSignedInFromLogin({ context: context(null), search: { next: "/readings/rd_ONE" } }),
    ).resolves.toBeUndefined();
  });
});
