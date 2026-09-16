import type { Query, UseQueryOptions } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  REFRESH_CAP_MS,
  nextInterval,
  recordFailure,
  recordSuccess,
  startWatch,
  withCap,
  type Schedule,
  type Watch,
} from "../status-refresh";

// Bounded automatic refresh on a TanStack Query query (acceptance matrix,
// Status refresh contract), in the terms of status-refresh.ts. The reading page
// uses it for one reading; the library's active-row refresh (#409) uses it for
// the page on screen, keyed by the query's hash so another page or filter starts
// a watch of its own.
//
// Query drives the requests and this decides when: `refetchInterval` is
// re-evaluated on every change to the query, so it is also where each answer is
// counted. Answers are told apart by Query's update counters, never by
// timestamps (two in one millisecond would look like one), and counting is
// idempotent because Query can ask for the interval more than once per answer.
//
// - Hidden tab: the interval does not fetch while unfocused (Query's default
//   `refetchIntervalInBackground: false`); becoming visible checks at once
//   through `refetchOnWindowFocus: "always"`, only while the watch is live.
// - A stopped watch (cap or failures) makes no request on its own again: not on
//   focus, and not on reconnect, which Query would otherwise do because a
//   failed check marks the query invalidated.
// - Unmounting removes the observer, which clears its timers and aborts the
//   in-flight request when the query function consumed its signal. That is
//   also how a 401 stops it: the shell replaces the page with the
//   expired-session page.

export type WatchStatus = "idle" | "watching" | WatchStopReason;
type WatchStopReason = NonNullable<Watch["stopped"]>;

/**
 * What a watch follows, or `null` for nothing to watch. `queryHash` names the
 * query the answer came from, for a page whose watch belongs to the query
 * rather than to anything in its data.
 */
export type KeyOf<T> = (data: T | undefined, queryHash: string) => string | null;

type QueryLike<T> = Pick<Query<T, Error, T, readonly unknown[]>, "state" | "cancel" | "queryHash">;

interface Seen {
  data: number;
  error: number;
}

class WatchStore<T> {
  watch: Watch | null = null;
  #query: QueryLike<T> | null = null;
  #seen: Seen = { data: 0, error: 0 };
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly keyOf: KeyOf<T>,
    private readonly schedule: Schedule,
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.watch;

  /** Counts any answer not seen yet, then the wait before the next check. */
  refetchInterval = (query: QueryLike<T>): number | false => {
    const now = Date.now();
    this.#query = query;
    this.#observe(query, now);
    return this.watch ? nextInterval(this.watch, now, this.schedule) : false;
  };

  /** Visible again: check at once while watching, never after a stop. */
  refetchOnWindowFocus = (query: QueryLike<T>): boolean | "always" => (this.#live(query) ? "always" : false);

  refetchOnReconnect = (query: QueryLike<T>): boolean =>
    this.#live(query) || this.keyOf(query.state.data, query.queryHash) === null;

  /**
   * Re-reads the cap; called when it passes with no answer to trigger it. An
   * automatic check that came due offline is held paused by Query and resumed
   * on reconnect regardless of `refetchOnReconnect`, so past the cap it is
   * dropped, and the query goes back to the answer it had.
   */
  checkCap = () => {
    if (!this.watch) return;
    this.#set(withCap(this.watch, Date.now()));
    if (this.watch?.stopped === "cap" && this.#query?.state.fetchStatus === "paused") {
      void this.#query.cancel({ revert: true });
    }
  };

  #live(query: QueryLike<T>): boolean {
    if (!this.watch) return false;
    if (this.keyOf(query.state.data, query.queryHash) !== this.watch.key) return false;
    return withCap(this.watch, Date.now()).stopped === null;
  }

  #observe({ state, queryHash }: Pick<QueryLike<T>, "state" | "queryHash">, now: number): void {
    const seen = { data: state.dataUpdateCount, error: state.errorUpdateCount };
    const answered = seen.data !== this.#seen.data || seen.error !== this.#seen.error;
    this.#seen = seen;
    const key = this.keyOf(state.data, queryHash);

    if (key === null) {
      this.#set(null);
      return;
    }
    if (key !== this.watch?.key) {
      // A new attempt (or the first one this page sees) starts a new watch; the
      // answer that revealed it is not one of its checks.
      this.#set(startWatch(key, now));
      return;
    }
    if (!answered) return;
    this.#set(state.status === "error" ? recordFailure(this.watch) : recordSuccess(this.watch));
  }

  #set(watch: Watch | null): void {
    if (watch === this.watch) return;
    this.watch = watch;
    for (const listener of this.#listeners) listener();
  }
}

/** The status watch's options, for the watching page's own query observer. */
export type QueryRefresh<T> = Pick<
  UseQueryOptions<T, Error, T, readonly unknown[]>,
  "refetchInterval" | "refetchOnWindowFocus" | "refetchOnReconnect"
>;

export interface StatusWatch<T> {
  /** Spread into the query's options. */
  options: {
    refetchInterval: (query: QueryLike<T>) => number | false;
    refetchOnWindowFocus: (query: QueryLike<T>) => boolean | "always";
    refetchOnReconnect: (query: QueryLike<T>) => boolean;
  };
  status: WatchStatus;
}

export function useStatusWatch<T>({
  keyOf,
  schedule,
}: {
  keyOf: KeyOf<T>;
  schedule: Schedule;
}): StatusWatch<T> {
  const [store] = useState(() => new WatchStore<T>(keyOf, schedule));
  const watch = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);

  // "Still processing" has to appear at the cap even though no answer arrives
  // then to re-evaluate anything.
  const startedAt = watch?.startedAt;
  const stopped = watch?.stopped;
  useEffect(() => {
    if (startedAt === undefined || stopped) return;
    const timer = setTimeout(store.checkCap, Math.max(0, startedAt + REFRESH_CAP_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [store, startedAt, stopped]);

  const options = useRef({
    refetchInterval: store.refetchInterval,
    refetchOnWindowFocus: store.refetchOnWindowFocus,
    refetchOnReconnect: store.refetchOnReconnect,
  }).current;

  return { options, status: watch === null ? "idle" : (watch.stopped ?? "watching") };
}
