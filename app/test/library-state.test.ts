import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "../src/api/errors";
import { libraryViewOf, type LibraryQueryState } from "../src/library-state";

// State selection for the library page (#416): which of the acceptance
// matrix's common states a query's fields name.

const PAGE = { readings: [], limit: 20, offset: 0, has_more: false };

/** What apiFetch throws when fetch itself failed, with the browser offline or not. */
function failedToFetch(offline: boolean): NetworkError {
  return new NetworkError(new TypeError("Failed to fetch"), offline);
}

function settled(over: Partial<LibraryQueryState>): LibraryQueryState {
  return { data: undefined, error: null, fetchStatus: "idle", ...over };
}

describe("libraryViewOf", () => {
  it("shows the page when the list succeeded", () => {
    expect(libraryViewOf(settled({ data: { state: "ready", page: PAGE } }))).toEqual({ kind: "ready", page: PAGE });
  });

  it("is loading while the first request is in flight", () => {
    expect(libraryViewOf(settled({ fetchStatus: "fetching" }))).toEqual({ kind: "loading" });
  });

  it("names permission denied and the account change from the result", () => {
    expect(libraryViewOf(settled({ data: { state: "forbidden" } }))).toEqual({ kind: "forbidden" });
    expect(libraryViewOf(settled({ data: { state: "account-changed", acting_tenant: "usr_b" } }))).toEqual({
      kind: "account-changed",
      actingTenant: "usr_b",
    });
    expect(libraryViewOf(settled({ data: { state: "account-changed" } }))).toEqual({ kind: "account-changed" });
  });

  it("is a server error for a 5xx, keeping the backend's message", () => {
    const error = new ApiError(503, "backend unavailable");
    expect(libraryViewOf(settled({ error }))).toEqual({ kind: "server-error", message: "backend unavailable" });
  });

  it("treats the binding being down and an unexpected status as server errors", () => {
    expect(libraryViewOf(settled({ error: new ApiError(0, "backend entrypoint failed") }))).toMatchObject({
      kind: "server-error",
    });
    expect(libraryViewOf(settled({ error: new ApiError(400, "invalid query") }))).toEqual({
      kind: "server-error",
      message: "invalid query",
    });
  });

  it("is offline when the fetch is paused for lack of a network", () => {
    expect(libraryViewOf(settled({ fetchStatus: "paused" }))).toEqual({
      kind: "offline",
    });
  });

  it("is offline when the fetch threw while the browser was offline, whatever it says now", () => {
    // The browser coming back does not change what the error was: the view
    // holds until the reconnect refetch answers.
    expect(libraryViewOf(settled({ error: failedToFetch(true) }))).toEqual({ kind: "offline" });
    expect(libraryViewOf(settled({ error: failedToFetch(true), fetchStatus: "fetching" }))).toEqual({ kind: "offline" });
  });

  it("keeps a settled permission or account state through an offline refetch", () => {
    expect(libraryViewOf(settled({ data: { state: "forbidden" }, fetchStatus: "paused" }))).toEqual({
      kind: "forbidden",
    });
    expect(
      libraryViewOf(settled({ data: { state: "account-changed", acting_tenant: "usr_b" }, error: failedToFetch(true) })),
    ).toEqual({ kind: "account-changed", actingTenant: "usr_b" });
  });

  it("keeps the loaded page through an offline refetch", () => {
    const data = { state: "ready" as const, page: PAGE };
    expect(libraryViewOf(settled({ data, fetchStatus: "paused" }))).toEqual({ kind: "offline", page: PAGE });
    expect(libraryViewOf(settled({ data, error: failedToFetch(true) }))).toEqual({
      kind: "offline",
      page: PAGE,
    });
  });

  it("is a server error when the fetch threw with the browser online", () => {
    expect(libraryViewOf(settled({ error: failedToFetch(false) }))).toEqual({
      kind: "server-error",
      message: "Failed to fetch",
    });
    // Thrown by something other than apiFetch: not the network's word.
    const error = new TypeError("Failed to fetch");
    expect(libraryViewOf(settled({ error }))).toEqual({ kind: "server-error", message: "Failed to fetch" });
  });

  it("never shows a stale page over a server error", () => {
    const data = { state: "ready" as const, page: PAGE };
    expect(libraryViewOf(settled({ data, error: new ApiError(502, "bad gateway") }))).toEqual({
      kind: "server-error",
      message: "bad gateway",
    });
  });
});
