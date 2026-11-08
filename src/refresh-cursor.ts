import { z } from "zod";

// Shard size for the hosted refresh scan and for one reserved batch.
// Pending arrays are capped at one shard. The worker in relationship-refresh.ts
// reserves and sends in the same order as refreshCursorPhase.
export const REFRESH_SCAN_SIZE = 25;

const TargetSchema = z.object({ id: z.string().min(1), key_prefix: z.string().startsWith("readings/") });
const PairSchema = z.object({ a: TargetSchema, b: TargetSchema }).refine((pair) => pair.a.id < pair.b.id);
const IdPairSchema = z.object({ a: z.string().min(1), b: z.string().min(1) }).refine((pair) => pair.a < pair.b);
const Cap = z.number().int().min(1).max(1000);

export const RefreshCursorSchema = z.object({
  version: z.literal(1),
  token: z.string().min(1),
  run_at: z.string().datetime(),
  budget_at: z.string().datetime(),
  limit: Cap,
  dispatched: z.number().int().nonnegative(),
  targets: z.array(TargetSchema),
  scan_offset: z.number().int().nonnegative(),
  candidates: z.array(TargetSchema),
  judge_offset: z.number().int().nonnegative(),
  pending: z.array(TargetSchema).max(REFRESH_SCAN_SIZE),
  // Defaults keep a cursor written before these fields parseable. Callers that
  // need to know whether the writer emitted the field must look at the raw
  // object. A missing tension_limit means that period dispatches no pairs.
  tension_limit: Cap.optional(),
  tension_dispatched: z.number().int().nonnegative().default(0),
  tension_candidates: z.array(PairSchema).default([]),
  tension_offset: z.number().int().nonnegative().default(0),
  tension_pending: z.array(PairSchema).max(REFRESH_SCAN_SIZE).default([]),
  repair_candidates: z.array(IdPairSchema).default([]),
  repair_offset: z.number().int().nonnegative().default(0),
  repair_pending: z.array(IdPairSchema).max(REFRESH_SCAN_SIZE).default([]),
  rollover: z.object({
    budget_at: z.string().datetime(),
    limit: Cap,
    tension_limit: Cap.optional(),
  }).optional(),
}).refine((cursor) =>
  cursor.scan_offset <= cursor.targets.length &&
  cursor.judge_offset <= cursor.candidates.length &&
  cursor.dispatched <= cursor.limit &&
  cursor.tension_offset <= cursor.tension_candidates.length &&
  cursor.tension_dispatched <= (cursor.tension_limit ?? 0) &&
  cursor.repair_offset <= cursor.repair_candidates.length &&
  [cursor.pending, cursor.tension_pending, cursor.repair_pending].filter((batch) => batch.length > 0).length <= 1,
);

export type RefreshCursor = z.infer<typeof RefreshCursorSchema>;

export const REFRESH_PHASES = [
  "sending connection judges",
  "sending tension pairs",
  "sending repairs",
  "scanning",
  "reserving repairs",
  "reserving connection judges",
  "reserving tension pairs",
  "idle until next Sunday",
] as const;

export type RefreshPhase = (typeof REFRESH_PHASES)[number];

export function refreshCursorPhase(cursor: RefreshCursor): RefreshPhase {
  if (cursor.pending.length > 0) return "sending connection judges";
  if (cursor.tension_pending.length > 0) return "sending tension pairs";
  if (cursor.repair_pending.length > 0) return "sending repairs";
  if (cursor.scan_offset < cursor.targets.length) return "scanning";
  if (cursor.repair_offset < cursor.repair_candidates.length) return "reserving repairs";
  if (cursor.judge_offset < cursor.candidates.length && cursor.dispatched < cursor.limit) {
    return "reserving connection judges";
  }
  if (
    cursor.tension_offset < cursor.tension_candidates.length &&
    cursor.tension_dispatched < (cursor.tension_limit ?? 0)
  ) {
    return "reserving tension pairs";
  }
  return "idle until next Sunday";
}
