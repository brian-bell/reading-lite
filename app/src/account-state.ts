import { NetworkError } from "./api/errors";

// What the account page shows for one of its reads (#340.1, #340.6): the
// acceptance matrix's common states chosen from the query observer's fields.
// Pure, so the choice is tested on its own; AccountPage renders whatever
// comes out. The sessions list and the notification settings both go through
// here.
//
// Same rules as libraryViewOf (#416): 403 and 412 are settled values and come
// before the network's own states; offline keeps what was already loaded; a
// 401 never reaches here (auth/session.ts).

/**
 * What an account read answered. 403 and 412 are values, as they are for the
 * library and a reading, so the page renders the shared state; a 401 and
 * anything unexpected throw.
 */
export type AccountRead<T> =
  | { state: "ready"; value: T }
  | { state: "forbidden" }
  | { state: "account-changed"; acting_tenant?: string };

/** A 403 or 412 an account write came back with. */
export type AccountRefusal = { kind: "forbidden" } | { kind: "account-changed"; actingTenant?: string };

export interface AccountQueryState<T> {
  data: AccountRead<T> | undefined;
  error: unknown;
  fetchStatus: "fetching" | "paused" | "idle";
}

export type AccountView<T> =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "account-changed"; actingTenant?: string }
  | { kind: "offline"; value?: T }
  | { kind: "server-error"; message: string }
  | { kind: "ready"; value: T };

export function accountViewOf<T>(state: AccountQueryState<T>): AccountView<T> {
  if (state.data?.state === "forbidden") return { kind: "forbidden" };
  if (state.data?.state === "account-changed") {
    return {
      kind: "account-changed",
      ...(state.data.acting_tenant === undefined ? {} : { actingTenant: state.data.acting_tenant }),
    };
  }
  const loaded = state.data?.state === "ready" ? { value: state.data.value } : {};
  if (state.fetchStatus === "paused") return { kind: "offline", ...loaded };
  if (state.error !== undefined && state.error !== null) {
    if (state.error instanceof NetworkError && state.error.offline) return { kind: "offline", ...loaded };
    return { kind: "server-error", message: messageOfError(state.error) };
  }
  if (state.data === undefined) return { kind: "loading" };
  return { kind: "ready", value: state.data.value };
}

/**
 * A refused write, stored as the read's own result so the page shows the
 * same state a refused read would.
 */
export function readRefusedBy(refusal: AccountRefusal): Exclude<AccountRead<never>, { state: "ready" }> {
  if (refusal.kind === "forbidden") return { state: "forbidden" };
  return {
    state: "account-changed",
    ...(refusal.actingTenant === undefined ? {} : { acting_tenant: refusal.actingTenant }),
  };
}

function messageOfError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}
