// Local attempt-state store. Loss of this file is safe by design: the worst
// case is re-attempting rows and re-hitting gates/caps, and the paid-action
// cap bounds the damage — so a missing, corrupted, or wrong-version file is
// treated as empty (with a warning) rather than fatal.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ListIndexItem } from "../../src/schemas/api";

export type AttemptOutcome = "challenge" | "imported" | "upgraded" | "gate_rejected" | "error" | "no_article";

export interface SidecarEntry {
  attempts: number;
  last_attempt_at: string;
  last_manifest_updated_at?: string;
  last_outcome: AttemptOutcome;
  next_eligible_at?: string;
  given_up: boolean;
}

export interface SidecarState {
  version: 1;
  readings: Record<string, SidecarEntry>;
}

const BACKOFF_BASE_MS = 60 * 60 * 1000;
const SUCCESS_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set(["imported", "upgraded"]);

export interface ClockDeps {
  now: () => Date;
  maxAttempts: number;
}

export function emptySidecar(): SidecarState {
  return { version: 1, readings: {} };
}

export async function loadSidecar(path: string, deps: { warn: (message: string) => void }): Promise<SidecarState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (e) {
    // Only a genuinely absent file is the silent first-run case. EACCES/EIO on
    // an existing file also starts empty (the loss-safe invariant above), but
    // it silently re-arms backed-off and given-up rows, so it has to be loud:
    // repeated scheduled runs would otherwise bypass the attempt ceiling.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      deps.warn(`sidecar at ${path} is unreadable (${e instanceof Error ? e.message : String(e)}); starting empty`);
    }
    return emptySidecar();
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; readings?: unknown };
    if (parsed.version !== 1 || typeof parsed.readings !== "object" || parsed.readings === null) {
      throw new Error(`unsupported sidecar shape (version ${String(parsed.version)})`);
    }
    return { version: 1, readings: parsed.readings as Record<string, SidecarEntry> };
  } catch (e) {
    deps.warn(`sidecar at ${path} is unreadable (${e instanceof Error ? e.message : String(e)}); starting empty`);
    return emptySidecar();
  }
}

export async function saveSidecar(path: string, state: SidecarState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

// Eligibility relative to what the Worker has done since we last acted:
//   newer manifest → the Worker acted; prior attempts/backoff no longer apply.
//   equal → honor backoff, attempt ceiling, and given_up.
//   older (clock skew, list rebuild) → treat as equal.
export function shouldAttempt(
  entry: SidecarEntry | undefined,
  row: ListIndexItem,
  deps: ClockDeps,
): { ok: boolean; why?: string } {
  if (!entry) return { ok: true };
  if (manifestMovedSince(entry, row)) return { ok: true };
  if (entry.given_up) return { ok: false, why: `given up after ${entry.attempts} attempts` };
  if (entry.attempts >= deps.maxAttempts) return { ok: false, why: `attempt ceiling (${deps.maxAttempts}) reached` };
  if (entry.next_eligible_at && deps.now().toISOString() < entry.next_eligible_at) {
    return { ok: false, why: `backing off until ${entry.next_eligible_at}` };
  }
  return { ok: true };
}

export function recordAttempt(
  state: SidecarState,
  row: ListIndexItem,
  outcome: AttemptOutcome,
  deps: ClockDeps,
): SidecarState {
  const prior = state.readings[row.id];
  const nowIso = deps.now().toISOString();
  const base: SidecarEntry = {
    attempts: 0,
    last_attempt_at: nowIso,
    last_manifest_updated_at: row.updated_at,
    last_outcome: outcome,
    given_up: false,
  };

  let entry: SidecarEntry;
  if (SUCCESS_OUTCOMES.has(outcome)) {
    entry = base;
  } else {
    // A failure after the Worker moved the manifest is a fresh classification,
    // not attempt N+1 of the old one.
    const priorAttempts = prior && !manifestMovedSince(prior, row) ? prior.attempts : 0;
    const attempts = priorAttempts + 1;
    entry = {
      ...base,
      attempts,
      next_eligible_at: new Date(deps.now().getTime() + BACKOFF_BASE_MS * 2 ** (attempts - 1)).toISOString(),
      given_up: attempts >= deps.maxAttempts,
    };
  }
  return { version: 1, readings: { ...state.readings, [row.id]: entry } };
}

function manifestMovedSince(entry: SidecarEntry, row: ListIndexItem): boolean {
  if (!row.updated_at) return false; // nothing to compare against
  // updated_at is optional on a list row, so a legacy row records no baseline.
  // Requiring both timestamps would suppress that entry forever: once the Worker
  // republishes the manifest and starts stamping updated_at, missing-to-present
  // is exactly the movement signal, so treat it as one.
  if (!entry.last_manifest_updated_at) return true;
  return row.updated_at > entry.last_manifest_updated_at;
}
