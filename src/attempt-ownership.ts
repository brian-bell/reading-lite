import type {
  Manifest,
  ProcessingAttemptTrigger,
} from "./schemas/manifest";

// The neutral low layer for an *attempt*: the args that describe one (its inputs)
// and the single ownership predicate computed from them. Both the processing
// pipeline (`process-reading.ts`) and the visibility writer
// (`reading-visibility.ts`) read this vocabulary, so it lives below both to keep
// the dependency graph acyclic (process-reading → reading-visibility →
// attempt-ownership, no back-edge). It depends only on the manifest schema.

export type ProcessReadingSource =
  | { kind: "url" }
  | { kind: "markdown"; markdown: string; title?: string };

export interface ProcessReadingArgs {
  id: string;
  url: string;
  urlHash: string;
  createdAt: string;
  keyPrefix: string;
  source?: ProcessReadingSource;
  attemptId?: string;
  attemptStartedAt?: string;
  trigger?: ProcessingAttemptTrigger;
  preserveReadyManifest?: Manifest;
  // Optional in TS for backwards compat with in-flight queue messages enqueued
  // before this field existed; current entry points always set it explicitly.
  email?: boolean;
}

// The single home of the `attemptId ?? at_${id}` fallback. The writer side
// (newProcessingAttempt, which stamps active_attempt.id) and every ownership gate
// (via attemptOwnership) derive identity through this one function, so the stored
// id and the id the gates compare against can never drift.
export function resolveAttemptId(args: ProcessReadingArgs): string {
  return args.attemptId ?? `at_${args.id}`;
}

// The one verdict every "does this attempt still own the reading?" site composes,
// so the five gates (artifact-write, terminal-write, vector-removal,
// list-row-removal, dead-letter) share a single definition of the active/last/
// pending rules. The gates differ on purpose — they pick different booleans — so
// this is a vocabulary, not a single predicate. Reads only the active_attempt /
// last_attempt / status shape that Manifest and ListIndexItem both carry.
interface AttemptOwnership {
  isActive: boolean; // active_attempt.id === attemptId
  isLast: boolean; // last_attempt.id === attemptId
  isLegacyPending: boolean; // active undefined && status pending (write-side gates)
  isVacantPending: boolean; // active undefined && last undefined && pending (cleanup gates)
  hasConflict: boolean; // active defined && active !== attemptId
}

type AttemptOwnershipSource = Pick<Manifest, "active_attempt" | "last_attempt" | "status">;

export function attemptOwnership(
  source: AttemptOwnershipSource | null,
  args: ProcessReadingArgs,
): AttemptOwnership {
  const attemptId = resolveAttemptId(args);
  const activeAttemptId = source?.active_attempt?.id;
  const lastAttemptId = source?.last_attempt?.id;
  const isPending = source?.status === "pending";
  return {
    isActive: activeAttemptId === attemptId,
    isLast: lastAttemptId === attemptId,
    isLegacyPending: activeAttemptId === undefined && isPending,
    isVacantPending: activeAttemptId === undefined && lastAttemptId === undefined && isPending,
    hasConflict: activeAttemptId !== undefined && activeAttemptId !== attemptId,
  };
}
