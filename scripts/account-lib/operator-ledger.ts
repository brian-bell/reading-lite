// The vector ledger as the offline operator commands see it (issue #195 S3).
//
// Two operator paths upsert vectors outside the Worker — `corpus backfill-vectors`
// and the batch pipeline's `write-phase` — and neither checks `users.status`.
// That was one of the four strandings
// `src/account-wipe.ts`'s header enumerated: an operator running one of them
// with `--execute` against an account mid-wipe could upsert a vector after the
// wipe's vectors phase had passed, leaving it with no derivable id. Recording
// the id here, before the upsert, is what closes it.
//
// Two scopes get the no-op rather than a D1 write, and both for the same
// reason: there is no tenant to key rows by.
//
//   - `--tenant global`, the pre-tenant corpus. It sits outside every tenant
//     key root and its vectors are un-namespaced, so no account wipe addresses
//     it (see the CLAUDE.md gotcha and slice S7).
//   - plan mode, which writes nothing anywhere.

import { d1VectorLedger, NO_OP_VECTOR_LEDGER, type VectorLedger } from "../../src/control-plane/vector-ledger";
import { parseTenantId } from "../../src/control-plane/ids";
import type { OperatorTenant } from "../corpus-lib/tenant";
import { UsageError } from "../ops-lib/contract";
import {
  CONTROL_PLANE_BY_BUCKET,
  controlPlaneDbForBucket,
  controlPlaneForBucket,
} from "./control-plane";

export interface OperatorLedgerOpts {
  tenant: OperatorTenant;
  /** The data bucket, which names the control plane that goes with it. */
  bucket: string;
  /** Plan mode gets the no-op: nothing is upserted, so nothing is ledgered. */
  execute: boolean;
  run?: (args: string[]) => Promise<{ stdout: string; code: number; stderr: string }>;
}

export function operatorVectorLedger(opts: OperatorLedgerOpts): VectorLedger {
  if (!opts.execute) return NO_OP_VECTOR_LEDGER;
  if (opts.tenant.kind !== "tenant") return NO_OP_VECTOR_LEDGER;
  const tenantId = parseTenantId(opts.tenant.tenantId);
  if (!tenantId) return NO_OP_VECTOR_LEDGER;
  // Throws for an unrecognised bucket rather than guessing a control plane.
  // Deliberately NOT caught: a command that cannot ledger its upserts is the
  // stranding this exists to prevent, so it must fail before it writes vectors
  // rather than write them un-ledgered. Callers refuse this at argument-parse
  // time (`assertOperatorLedgerAvailable`) so an operator hears about it before
  // a plan they have already accepted, not part-way through an execute.
  return d1VectorLedger(controlPlaneDbForBucket(opts.bucket, opts.run), tenantId);
}

/**
 * Refuse, at parse time, a `--tenant`/`--bucket` pair this ledger cannot serve.
 *
 * A real tenant against a bucket with no mapped control plane has nowhere to
 * record its ids, and a vector written without a ledger row is unaddressable
 * once the reading's R2 objects are gone. The check belongs up front rather
 * than at the first upsert: `corpus ingest` and `corpus recover --batch` are
 * long, paid, resumable runs, and discovering this half way through one is the
 * worst moment to discover it.
 *
 * `--tenant global` passes, because no account wipe addresses the pre-tenant
 * corpus and nothing needs ledgering for it.
 */
export function assertOperatorLedgerAvailable(
  tenant: OperatorTenant,
  bucket: string,
): void {
  if (tenant.kind !== "tenant") return;
  if (controlPlaneForBucket(bucket) !== undefined) return;
  throw new UsageError(
    `--tenant ${tenant.tenantId} needs a control plane to record vector-ledger rows in, and ` +
      `no control-plane database is mapped to bucket '${bucket}'. Known buckets: ` +
      `${Object.keys(CONTROL_PLANE_BY_BUCKET).join(", ")}. Use --tenant global for the ` +
      `pre-tenant corpus, which no account wipe addresses.`,
  );
}
