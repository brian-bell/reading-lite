import { z } from "zod";
import { ApiError } from "./api/errors";
import {
  absent,
  actingTenantOf,
  messageOf,
  ProcessingAttemptSchema,
  ReadingErrorSchema,
  type SimilaritySnapshot,
} from "./reading";
import { dateTimeOn } from "./reading-presentation";

// The Details section's on-demand data (#373; design spec, Reading surface:
// "Diagnostics load only when opened"): GET /api/readings/:id/diagnostics,
// fetched in the browser once the disclosure is opened and never during a
// server render. The body is the backend's GetReadingDiagnosticsResponse
// (src/schemas/api.ts); the projection below declares only what the section
// renders, loose and null-tolerant like the reading's own (reading.ts).
//
// 403 and the 412 expected-tenant mismatch are values, as they are for the
// source: no Retry changes them. A 401 throws into the shell's expired-session
// page. A 404 throws too: the reading itself rendered, so a diagnostics 404 is
// a failure worth retrying rather than a state of its own.

/** ProcessingAttemptEventSchema. `stage` and `status` are open strings, as the attempt's are. */
export const AttemptEventSchema = z.looseObject({
  stage: z.string(),
  status: z.string(),
  at: absent(z.string()),
  duration_ms: absent(z.number()),
  error: absent(ReadingErrorSchema),
});
export type AttemptEvent = z.output<typeof AttemptEventSchema>;

/** The full attempt log, which is the manifest's summary plus its events. */
export const AttemptLogSchema = ProcessingAttemptSchema.extend({
  events: absent(z.array(AttemptEventSchema)),
});
export type AttemptLog = z.output<typeof AttemptLogSchema>;

const PointerCheckSchema = z.looseObject({
  exists: z.boolean(),
  matches_manifest: z.boolean(),
});
export type PointerCheck = z.output<typeof PointerCheckSchema>;

export const ReadingObjectSchema = z.looseObject({
  key: z.string(),
  size: absent(z.number()),
  uploaded: absent(z.string()),
});
export type ReadingObject = z.output<typeof ReadingObjectSchema>;

export const DiagnosticsSchema = z.looseObject({
  id: z.string(),
  key_prefix: z.string(),
  index_item: absent(z.looseObject({ status: absent(z.string()) })),
  pointers: z.looseObject({
    by_id: PointerCheckSchema,
    by_url: PointerCheckSchema,
  }),
  objects: z.array(ReadingObjectSchema),
  attempts: z.array(AttemptLogSchema),
});
export type Diagnostics = z.output<typeof DiagnosticsSchema>;

export type DiagnosticsResult =
  | { state: "ready"; diagnostics: Diagnostics }
  | { state: "forbidden" }
  | { state: "account-changed"; acting_tenant?: string };

export function diagnosticsQueryKey(id: string): readonly unknown[] {
  return ["reading-diagnostics", id];
}

export function diagnosticsFromResponse(status: number, body: unknown): DiagnosticsResult {
  if (status === 200) {
    const parsed = DiagnosticsSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(status, "diagnostics returned an unexpected body");
    return { state: "ready", diagnostics: parsed.data };
  }
  if (status === 403) return { state: "forbidden" };
  if (status === 412) return { state: "account-changed", acting_tenant: actingTenantOf(body) };
  throw new ApiError(status, messageOf(body) ?? `diagnostics returned ${status}`);
}

// ---------------------------------------------------------------------------
// Presentation: fixed labels for the section's facts.

export interface Fact {
  label: string;
  value: string;
}

/**
 * The similarity numbers behind the novelty verdict (design spec, Novelty:
 * "Similarity numbers (count, max, mean, computed_at) go in Details, not the
 * panel"). A missing value is omitted, never shown as a dash or a zero.
 */
export function similarityFacts(similarity: SimilaritySnapshot | undefined): Fact[] {
  if (!similarity) return [];
  const facts: Fact[] = [];
  if (similarity.count !== undefined) facts.push({ label: "Close readings", value: String(similarity.count) });
  if (similarity.max !== undefined) facts.push({ label: "Highest similarity", value: score(similarity.max) });
  if (similarity.mean !== undefined) facts.push({ label: "Mean similarity", value: score(similarity.mean) });
  const computed = dateTimeOn(similarity.computed_at);
  if (computed) facts.push({ label: "Computed", value: computed });
  return facts;
}

/** A cosine score to two decimals, as the numbers are compared in the operator docs. */
export function score(value: number): string {
  return value.toFixed(2);
}

/** The legacy SPA's three words for a pointer check, unchanged. */
export function pointerVerdict(check: PointerCheck): "OK" | "Mismatch" | "Missing" {
  if (!check.exists) return "Missing";
  return check.matches_manifest ? "OK" : "Mismatch";
}

/**
 * An object key relative to the reading's prefix: "raw.html",
 * "revisions/at_…/extracted.md". The endpoint's `key_prefix` is the stored, relative
 * one, while object keys are absolute bucket keys that carry the tenant root
 * in front of it on the tenant data plane, so the prefix is looked for
 * anywhere in the key rather than at its start.
 */
export function objectName(key: string, keyPrefix: string): string {
  const prefix = `${keyPrefix}/`;
  const at = key.indexOf(prefix);
  return at === -1 ? key : key.slice(at + prefix.length);
}

/** A byte count as a reader would size a file. */
export function byteSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TRIGGER_LABELS: Record<string, string> = {
  submit: "Saved",
  reprocess: "Reprocessed",
  import: "Imported",
};

const ATTEMPT_STATUS_LABELS: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

const EVENT_STATUS_LABELS: Record<string, string> = {
  started: "Started",
  succeeded: "Done",
  failed: "Failed",
};

/** "submit" | "reprocess" | "import" → what the reader did; an unknown trigger keeps its name. */
export function attemptTriggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

export function attemptStatusLabel(status: string): string {
  return ATTEMPT_STATUS_LABELS[status] ?? status;
}

export function eventStatusLabel(status: string): string {
  return EVENT_STATUS_LABELS[status] ?? status;
}
