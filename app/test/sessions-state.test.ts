import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "../src/api/errors";
import { sessionsViewOf, type SessionsQueryState } from "../src/sessions-state";

const LISTED = { sessions: [], session_cap_warning: null };

function failedToFetch(offline: boolean): NetworkError {
  return new NetworkError(new TypeError("Failed to fetch"), offline);
}

function settled(over: Partial<SessionsQueryState>): SessionsQueryState {
  return { data: undefined, error: null, fetchStatus: "idle", ...over };
}

describe("sessionsViewOf", () => {
  it("shows the list when the query succeeded", () => {
    expect(sessionsViewOf(settled({ data: { state: "ready", listed: LISTED } }))).toEqual({
      kind: "ready",
      listed: LISTED,
    });
  });

  it("is loading while the first request is in flight", () => {
    expect(sessionsViewOf(settled({ fetchStatus: "fetching" }))).toEqual({ kind: "loading" });
  });

  it("names permission denied and the account change from the result", () => {
    expect(sessionsViewOf(settled({ data: { state: "forbidden" } }))).toEqual({ kind: "forbidden" });
    expect(sessionsViewOf(settled({ data: { state: "account-changed", acting_tenant: "usr_b" } }))).toEqual({
      kind: "account-changed",
      actingTenant: "usr_b",
    });
    expect(sessionsViewOf(settled({ data: { state: "account-changed" } }))).toEqual({ kind: "account-changed" });
  });

  it("is a server error for a 5xx, keeping the backend's message", () => {
    const error = new ApiError(503, "backend unavailable");
    expect(sessionsViewOf(settled({ error }))).toEqual({ kind: "server-error", message: "backend unavailable" });
  });

  it("is offline when the fetch is paused for lack of a network", () => {
    expect(sessionsViewOf(settled({ fetchStatus: "paused" }))).toEqual({ kind: "offline" });
  });

  it("is offline when the fetch threw while the browser was offline", () => {
    expect(sessionsViewOf(settled({ error: failedToFetch(true) }))).toEqual({ kind: "offline" });
  });

  it("keeps a settled permission or account state through an offline refetch", () => {
    expect(sessionsViewOf(settled({ data: { state: "forbidden" }, fetchStatus: "paused" }))).toEqual({
      kind: "forbidden",
    });
    expect(
      sessionsViewOf(
        settled({ data: { state: "account-changed", acting_tenant: "usr_b" }, error: failedToFetch(true) }),
      ),
    ).toEqual({ kind: "account-changed", actingTenant: "usr_b" });
  });

  it("keeps the loaded list through an offline refetch", () => {
    const data = { state: "ready" as const, listed: LISTED };
    expect(sessionsViewOf(settled({ data, fetchStatus: "paused" }))).toEqual({ kind: "offline", listed: LISTED });
    expect(sessionsViewOf(settled({ data, error: failedToFetch(true) }))).toEqual({
      kind: "offline",
      listed: LISTED,
    });
  });

  it("is a server error when the fetch threw with the browser online", () => {
    expect(sessionsViewOf(settled({ error: failedToFetch(false) }))).toEqual({
      kind: "server-error",
      message: "Failed to fetch",
    });
  });

  it("never shows a stale list over a server error", () => {
    const data = { state: "ready" as const, listed: LISTED };
    expect(sessionsViewOf(settled({ data, error: new ApiError(502, "bad gateway") }))).toEqual({
      kind: "server-error",
      message: "bad gateway",
    });
  });
});
