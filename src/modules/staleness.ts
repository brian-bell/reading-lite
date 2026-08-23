import type { ManifestError, ManifestStatus, ProcessingAttemptSummary } from "../schemas/manifest";

/**
 * The minimal record shape the stale-annotation rule decides over. Manifests
 * and list-index items are both structurally compatible with this interface
 * and pass their records directly.
 */
export interface StaleInput {
  status: ManifestStatus;
  /** Preferred staleness reference. Always present on manifests. */
  updated_at?: string;
  /** Fallback reference for older index entries that predate `updated_at`. */
  created_at?: string;
  active_attempt?: ProcessingAttemptSummary;
}

/**
 * The record shape {@link applyStaleness} rewrites: {@link StaleInput} plus the
 * fields the verdict lands on. `Manifest` and `ListIndexItem` both satisfy it.
 */
export interface ApplyStalenessRecord extends StaleInput {
  last_attempt?: ProcessingAttemptSummary;
  error?: ManifestError;
}

/**
 * The transition(s) to apply for a stale record. At most one of the two is
 * ever set — an expired active attempt short-circuits the pending check, mirroring
 * the original router logic.
 */
export interface StaleVerdict {
  /** When a `running` active attempt has exceeded TTL, the failed summary to apply; else null. */
  expiredActiveAttempt: ProcessingAttemptSummary | null;
  /** When a `pending` record has exceeded TTL (with no active attempt firing), the error to apply; else null. */
  pendingError: ManifestError | null;
}

/**
 * The stale-annotation rule: surface a `running` attempt past TTL, or a
 * `pending` record past TTL, as `failed` — a read-time decision only. The
 * caller owns reading `PENDING_TTL_SECONDS` from env and applying the verdict
 * onto its concrete record type.
 */
export function stalenessOf(input: StaleInput, ttlSeconds: number, nowIso: string): StaleVerdict {
  if (isBatchOwnedPending(input)) {
    return { expiredActiveAttempt: null, pendingError: null };
  }

  const expired = expiredActiveAttempt(input.active_attempt, ttlSeconds, nowIso);
  if (expired) {
    return { expiredActiveAttempt: expired, pendingError: null };
  }

  if (input.status !== "pending") {
    return { expiredActiveAttempt: null, pendingError: null };
  }

  // Prefer updated_at; older index entries (pre-updated_at) fall back to created_at.
  const ref = input.updated_at ?? input.created_at;
  const refMs = ref === undefined ? Number.NaN : Date.parse(ref);
  const now = Date.parse(nowIso);
  if (Number.isFinite(refMs) && now - refMs > ttlSeconds * 1000) {
    return {
      expiredActiveAttempt: null,
      pendingError: { code: "stale_pending", message: `pending > ${ttlSeconds}s` },
    };
  }

  return { expiredActiveAttempt: null, pendingError: null };
}

/**
 * The apply half of the rule, single-homed with the verdict so the manifest
 * path and the index-item path can never drift: an expired running attempt is
 * cleared into `last_attempt` (flipping a pending record to `failed`); a stale
 * pending record with no attempt fails with `stale_pending`. Fresh records are
 * returned unchanged. Read-time only — callers never write the result back.
 */
export function applyStaleness<T extends ApplyStalenessRecord>(
  record: T,
  ttlSeconds: number,
  nowIso: string,
): T {
  const verdict = stalenessOf(record, ttlSeconds, nowIso);
  if (verdict.expiredActiveAttempt) {
    const next: T = {
      ...record,
      active_attempt: undefined,
      last_attempt: verdict.expiredActiveAttempt,
      updated_at: verdict.expiredActiveAttempt.finished_at ?? nowIso,
    };
    if (record.status === "pending") {
      return { ...next, status: "failed", error: verdict.expiredActiveAttempt.error };
    }
    return next;
  }

  if (verdict.pendingError) {
    return { ...record, status: "failed", error: verdict.pendingError };
  }
  return record;
}

export function isBatchOwnedPending(input: StaleInput): boolean {
  const attempt = input.active_attempt;
  return (
    input.status === "pending" &&
    typeof attempt?.id === "string" &&
    attempt.id.startsWith("batch_") &&
    attempt.trigger === "import" &&
    attempt.status === "running" &&
    attempt.stage === "summarize"
  );
}

/**
 * If `activeAttempt` is `running` and has exceeded TTL, the failed summary it
 * should be replaced with; otherwise null.
 */
export function expiredActiveAttempt(
  activeAttempt: ProcessingAttemptSummary | undefined,
  ttlSeconds: number,
  nowIso: string,
): ProcessingAttemptSummary | null {
  if (activeAttempt?.status !== "running") return null;
  const startedAt = Date.parse(activeAttempt.started_at);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return null;
  if (now - startedAt <= ttlSeconds * 1000) return null;
  return {
    ...activeAttempt,
    status: "failed",
    finished_at: nowIso,
    error: {
      code: "stale_active_attempt",
      message: `active attempt > ${ttlSeconds}s`,
      ...(activeAttempt.stage ? { stage: activeAttempt.stage } : {}),
      failed_at: nowIso,
      retryable: true,
    },
  };
}
