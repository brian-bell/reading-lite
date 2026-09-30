// The return trail (design spec, Routes and navigation state): following a
// connection or tension records where the reader came from and why, in router
// history state, at most 10 hops. The destination shows the previous title and
// reason with "Back to {title}"; browser Back does the same because each
// history entry carries its own trail. A reload or a shared link drops the
// trail and keeps the reading.
//
// Dropping on reload takes one deliberate step. @tanstack/history rebuilds the
// location from `window.history.state` when the document loads, so a trail
// written before a reload would come back with it. Every trail therefore names
// the document load that built it, and only a trail from this load counts.
// A server render never matches either, so the trail is never part of the
// server's HTML and hydration has nothing to disagree about.

import type { HistoryState } from "@tanstack/history";

export interface TrailHop {
  /** The reading the reader followed the relationship from. */
  id: string;
  title: string;
  kind: "connection" | "tension";
  /** The relationship's reason, kept so a removed target can still explain itself. */
  reason: string;
}

export interface TrailState {
  /** The document load that wrote this trail; see currentLoadId. */
  load: string;
  hops: TrailHop[];
}

declare module "@tanstack/history" {
  interface HistoryState {
    trail?: TrailState;
  }
}

export const TRAIL_LIMIT = 10;

/**
 * Where a hop's reading lives: the reader's library, or the public sample
 * library (reading-lite-gh341.10), whose relationships lead only to other
 * samples.
 */
export type ReadingRoute = "/readings/$id" | "/samples/$id";

/**
 * One id per document load, minted on first use. Not at import time: workerd
 * refuses random values in module scope, and this module is part of the
 * reading route's server bundle. The server's id never matches a browser's.
 */
let loadId: string | undefined;
export function currentLoadId(): string {
  loadId ??= globalThis.crypto?.randomUUID?.() ?? `load-${Date.now()}-${Math.random()}`;
  return loadId;
}

/**
 * The empty trail, one shared instance. `trailOf` is a location selector
 * (useLocation), and a selector that returns a fresh array each call is a
 * snapshot that never settles: React refuses it during a server render and
 * re-renders endlessly in the browser.
 */
const NO_TRAIL: readonly TrailHop[] = Object.freeze([]);

/** The hops in a location's state, or none when the state is from another load. */
export function trailOf(state: HistoryState | undefined, loadId: string = currentLoadId()): readonly TrailHop[] {
  const trail = state?.trail;
  if (!trail || trail.load !== loadId) return NO_TRAIL;
  return trail.hops;
}

/** The trail the destination of a followed relationship carries. */
export function trailAfterFollowing(current: readonly TrailHop[], hop: TrailHop, loadId: string = currentLoadId()): TrailState {
  return { load: loadId, hops: [...current, hop].slice(-TRAIL_LIMIT) };
}

/** The trail the previous reading carries when the reader returns by link rather than history. */
export function trailAfterReturning(current: readonly TrailHop[], loadId: string = currentLoadId()): TrailState {
  return { load: loadId, hops: current.slice(0, -1) };
}

/** The hop the reader would return to. */
export function previousHop(hops: readonly TrailHop[]): TrailHop | undefined {
  return hops.at(-1);
}
