import { NetworkError } from "./api/errors";
import type { SessionsList, SessionsResult } from "./sessions";

// What the account page shows for the sessions query (#340.1): the acceptance
// matrix's common states chosen from the query observer's fields. Pure, so
// the choice is tested on its own; AccountPage renders whatever comes out.
//
// Same rules as libraryViewOf (#416): 403 and 412 are settled values and come
// before the network's own states; offline keeps a list already loaded; a 401
// never reaches here (auth/session.ts).

export interface SessionsQueryState {
  data: SessionsResult | undefined;
  error: unknown;
  fetchStatus: "fetching" | "paused" | "idle";
}

export type SessionsView =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "offline"; listed?: SessionsList }
  | { kind: "server-error"; message: string }
  | { kind: "ready"; listed: SessionsList };

export function sessionsViewOf(state: SessionsQueryState): SessionsView {
  if (state.data?.state === "forbidden") return { kind: "forbidden" };
  if (state.data?.state === "account-changed") {
    return {
      kind: "account-changed",
      ...(state.data.acting_tenant === undefined ? {} : { actingTenant: state.data.acting_tenant }),
    };
  }
  const listed = state.data?.listed;
  if (state.fetchStatus === "paused") return { kind: "offline", ...(listed ? { listed } : {}) };
  if (state.error !== undefined && state.error !== null) {
    if (state.error instanceof NetworkError && state.error.offline) {
      return { kind: "offline", ...(listed ? { listed } : {}) };
    }
    return { kind: "server-error", message: messageOfError(state.error) };
  }
  if (state.data === undefined) return { kind: "loading" };
  return { kind: "ready", listed: state.data.listed };
}

function messageOfError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}
