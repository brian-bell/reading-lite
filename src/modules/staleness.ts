import type { ManifestError, ManifestStatus, ProcessingAttemptSummary } from "../schemas/manifest";

/**
 * The minimal record shape the stale-annotation rule decides over. Both the
 * manifest path (`annotateStale`) and the index-item path
 * (`annotateStaleIndexItem`) in `router.ts` are structurally compatible with
 * this interface and pass their records directly.
 */
export interface StaleInput {
  status: ManifestStatus;
  /** Preferred staleness reference. Always present on manifests. */
  updated_at?: string;
  /** Fallback reference for older index entries that predate `updated_at`. */
  created_at?: string;
  active_attempt?: ProcessingAttemptSummary;
  batch_claim?: boolean;
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
  const expired = expiredActiveAttempt(input.active_attempt, ttlSeconds, nowIso);
  if (expired) {
    return { expiredActiveAttempt: expired, pendingError: null };
  }

  if (input.status !== "pending") {
    return { expiredActiveAttempt: null, pendingError: null };
  }
  if (input.batch_claim === true) {
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
