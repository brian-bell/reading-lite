import { NetworkError } from "./api/errors";
import type { LibraryPage, LibraryResult } from "./library";

// What the library shows for one page's query (#416): the acceptance matrix's
// common states chosen from the query observer's fields. Pure, so the choice
// is tested on its own; LibraryPage renders whatever comes out.
//
// The result values (ready, forbidden, account-changed) come from
// libraryFromResponse; anything unexpected reaches here as an error. A 401
// never does: the session machinery in auth/session.ts drops the identity
// first, and the page is the shell's or the sign-in form before this runs.
// Forbidden and account-changed are settled: no refresh changes them while
// offline, so they come before the network's own states.
// Offline has two shapes in TanStack Query's default network mode: a fetch
// started while offline never runs and the query sits `paused`, and a fetch
// that fails after the browser went offline rejects (retries are off) with a
// NetworkError that recorded the browser was offline when it threw. Both are
// the offline state, which keeps a page already loaded, and the second stays
// so until the reconnect refetch answers: the browser being back does not
// change what the error was. Anything else thrown, the binding being down
// (status 0) included, is the retryable server-error state.

export interface LibraryQueryState {
  data: LibraryResult | undefined;
  error: unknown;
  fetchStatus: "fetching" | "paused" | "idle";
}

export type LibraryView =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "offline"; page?: LibraryPage }
  | { kind: "server-error"; message: string }
  | { kind: "ready"; page: LibraryPage };

export function libraryViewOf(state: LibraryQueryState): LibraryView {
  if (state.data?.state === "forbidden") return { kind: "forbidden" };
  if (state.data?.state === "account-changed") {
    return {
      kind: "account-changed",
      ...(state.data.acting_tenant === undefined ? {} : { actingTenant: state.data.acting_tenant }),
    };
  }
  const page = state.data?.page;
  if (state.fetchStatus === "paused") return { kind: "offline", ...(page ? { page } : {}) };
  if (state.error !== undefined && state.error !== null) {
    if (state.error instanceof NetworkError && state.error.offline) return { kind: "offline", ...(page ? { page } : {}) };
    return { kind: "server-error", message: messageOfError(state.error) };
  }
  // Without placeholder data, pending is exactly having no data yet.
  if (state.data === undefined) return { kind: "loading" };
  return { kind: "ready", page: state.data.page };
}

function messageOfError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}
