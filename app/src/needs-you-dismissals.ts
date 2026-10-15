import { useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import type { DeskRead } from "./desk";
import type { LibraryRow } from "./library";
import { reprocessFailed } from "./reading-state";

// Dismissals for the desk's Needs you section. One entry per reading, because
// only that reading's latest attempt can be on screen: a newer failed attempt
// misses the entry and the row returns. Dismissing that attempt replaces it.
// The server render cannot read storage, so it shows every row.

/** One Needs you row as the section renders it. */
export interface NeedsYouRow {
  row: LibraryRow;
  /**
   * Present only when the row is a ready reading's failed reprocess.
   * Sets that failure aside at `now`, epoch ms. The same failure keeps the
   * first time. A status `failed` row never has one.
   */
  dismiss?: (now: number) => void;
}

/** What the Needs you section shows after this browser's dismissals. */
export interface NeedsYou {
  /** The server's `needs_you` rows, in its order, less the dismissed ones. */
  rows: NeedsYouRow[];
  /**
   * `needs_you_total` less the rows hidden here. The server's total is not
   * rewritten, and rows past the loaded page are not filled in.
   */
  total: number;
}

const STORAGE_KEY = "reading-lite.needsYouDismissals";

/**
 * A dismissal lasts this long from when it was made. Strictly more drops it.
 * The server's age-out runs from `finished_at`, so this stays a separate
 * constant.
 */
const DISMISSAL_TTL_MS = 7 * 86_400_000;

interface DismissalKey {
  readingId: string;
  attemptId: string;
}

const StoredDismissalSchema = z.object({
  attempt_id: z.string().min(1),
  dismissed_at: z.number().int().nonnegative(),
});
type StoredDismissal = z.infer<typeof StoredDismissalSchema>;

type Dismissals = ReadonlyMap<string, StoredDismissal>;

/**
 * Set only when a write threw. It wins over storage, because a stale stored
 * value would bring the row back on this page. A write storage takes clears
 * it. A reload starts without it.
 */
let unstored: string | undefined;
const listeners = new Set<() => void>();

function dismissalKeyOf(row: LibraryRow): DismissalKey | undefined {
  if (!reprocessFailed(row) || row.last_attempt === undefined) return undefined;
  return { readingId: row.id, attemptId: row.last_attempt.id };
}

function storedEntries(stored: string | null): readonly [string, unknown][] | undefined {
  if (stored === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.entries(value);
}

function keep(entries: readonly [string, unknown][], now: number): Map<string, StoredDismissal> {
  const dismissals = new Map<string, StoredDismissal>();
  for (const [readingId, entry] of entries) {
    const parsed = StoredDismissalSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (now - parsed.data.dismissed_at > DISMISSAL_TTL_MS) continue;
    dismissals.set(readingId, parsed.data);
  }
  return dismissals;
}

function parse(stored: string | null, now: number): Dismissals {
  const entries = storedEntries(stored);
  if (entries === undefined) return new Map();
  return keep(entries, now);
}

function serialize(dismissals: Dismissals): string {
  return JSON.stringify(Object.fromEntries(dismissals));
}

/** The stored JSON after a prune, or null when this value must be left alone. */
function pruned(stored: string | null, now: number): string | null {
  const entries = storedEntries(stored);
  if (entries === undefined) return null;
  const dismissals = keep(entries, now);
  if (dismissals.size === entries.length) return null;
  return serialize(dismissals);
}

function withDismissal(stored: string | null, key: DismissalKey, now: number): string {
  const dismissals = new Map(parse(stored, now));
  if (dismissals.get(key.readingId)?.attempt_id !== key.attemptId) {
    dismissals.set(key.readingId, { attempt_id: key.attemptId, dismissed_at: now });
  }
  return serialize(dismissals);
}

function read(): string | null {
  if (unstored !== undefined) return unstored;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function write(next: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
    unstored = undefined;
  } catch {
    unstored = next;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function serverSnapshot(): null {
  return null;
}

export function useNeedsYou(desk: Pick<DeskRead, "needs_you" | "needs_you_total">, now: number): NeedsYou {
  const stored = useSyncExternalStore(subscribe, read, serverSnapshot);
  // After hydration. getSnapshot must not write, and the server render must not either.
  useEffect(() => {
    const next = pruned(stored, now);
    if (next !== null) write(next);
  }, [stored, now]);
  return useMemo(() => {
    const dismissals = parse(stored, now);
    const rows = desk.needs_you.flatMap((row): NeedsYouRow[] => {
      const key = dismissalKeyOf(row);
      if (key === undefined) return [{ row }];
      if (dismissals.get(key.readingId)?.attempt_id === key.attemptId) return [];
      return [{ row, dismiss: (at) => write(withDismissal(read(), key, at)) }];
    });
    return { rows, total: desk.needs_you_total - (desk.needs_you.length - rows.length) };
  }, [desk.needs_you, desk.needs_you_total, stored, now]);
}
