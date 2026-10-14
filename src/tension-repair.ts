/** Hosted one-sided tension repair (reading-lite-qxfh): the free half of
 * `ops corpus refresh-tensions`, run for one pair the weekly scan collected.
 * It calls no provider, so it takes no lease, spend admission or checkpoint:
 * the repair is recomputed from the live pair on every delivery, which makes
 * a redelivery of a finished repair a noop. The rules are `findOneSided`'s:
 * mirror a judgement or a judged record the other side lost, drop a stale
 * side, and purge a tension naming a partner that is no longer ready — the
 * dangling entry tier 1 would otherwise flag `stale_connection` every night.
 * Every side the pair's repairs write goes in one compare-and-replace on the
 * versions read here, with the side a mirror copies from locked and checked
 * alongside; if either changed, nothing is written and the next scan plans
 * again. Only `tensions` and `tensions_judged` change.
 * Running predicates overlay applyStaleness: an in-TTL running side defers
 * with DeferPaidWorkError so consumeRelationshipRefresh re-enqueues the same
 * identity; a zombie (TTL-expired) attempt is not running.
 */
import type { Env } from "./index";
import { sha256Hex, type Services } from "./services";
import type { RefreshEnvelope } from "./relationship-refresh";
import { activeRefreshFounder } from "./relationship-refresh";
import { fromSql } from "./control-plane/db";
import { DeferPaidWorkError } from "./control-plane/processing-leases";
import { withSqlSession, type Sql } from "./modules/db/sql";
import type { TenantContext } from "./control-plane/ids";
import { pgReadingStoreFor } from "./modules/stores/postgres/reading-store";
import { pgReadingWriterFor } from "./modules/stores/postgres/reading-writer";
import { pairTensionRepairs, repairTarget, repairTensionSide } from "./modules/tension-judgement/refresh";
import { ManifestSchema, type Manifest } from "./schemas/manifest";
import { effectivelyRunning, pendingTtlSeconds } from "./modules/staleness";

type RepairJob = Extract<RefreshEnvelope, { kind: "repair" }>;

export async function processTensionRepair(job: RepairJob, env: Env, services: Services): Promise<void> {
  if (env.RELATIONSHIP_REFRESH !== "1") return;
  const tenant = await activeRefreshFounder(env);
  if (!tenant || tenant.tenantId !== job.tenantId) return;
  // The scan only ever sends a canonical pair; anything else is not one of ours.
  if (!(job.a < job.b)) {
    console.error("tension_repair_invalid_pair");
    return;
  }
  await withSqlSession(env, (sql) => repairWith(sql, tenant, job, env, services));
}

async function repairWith(sql: Sql, tenant: TenantContext, job: RepairJob, env: Env, services: Services): Promise<void> {
  const rows = pgReadingStoreFor(sql, tenant);
  const versionOf = (manifest: Manifest) => sha256Hex(JSON.stringify(manifest));
  const logNoop = (reason: string) => {
    console.warn(JSON.stringify({ event: "tension_repair_noop", a: job.a, b: job.b, reason }));
  };
  const ttl = pendingTtlSeconds(env.PENDING_TTL_SECONDS);
  const listed = await rows.relationshipTargets([job.a, job.b]);
  // A side absent from here is gone or not ready, which is what makes its
  // partner's entries dangling. A ready side that fails to load is left out
  // of `manifests` but stays ready, and findOneSided skips what it cannot see.
  const readyIds = new Set(listed.flatMap(row => row.status === "ready" ? [row.id] : []));
  const manifests = new Map<string, Manifest>();
  const versions = new Map<string, string>();
  for (const id of [job.a, job.b]) {
    if (!readyIds.has(id)) continue;
    const found = await rows.loadReadingById(id);
    if (!found || found.manifest.id !== id || found.manifest.status !== "ready") continue;
    if (effectivelyRunning(found.manifest, ttl, services.now())) {
      console.warn(JSON.stringify({ event: "tension_repair_deferred", a: job.a, b: job.b, reason: "reading_running", readingId: id }));
      throw new DeferPaidWorkError();
    }
    manifests.set(id, found.manifest);
    versions.set(id, await versionOf(found.manifest));
  }
  const repairs = pairTensionRepairs(job.a, job.b, manifests, readyIds);
  if (repairs.length === 0) {
    logNoop("nothing_to_repair");
    return;
  }
  // Repairs for one pair can write both sides; apply each onto the side's
  // latest working copy so two on the same reading compose.
  const next = new Map<string, Manifest>();
  for (const repair of repairs) {
    const id = repairTarget(repair);
    const merged = repairTensionSide(next.get(id) ?? manifests.get(id), repair);
    if (!merged.ok) throw new Error(merged.error);
    next.set(id, ManifestSchema.parse(merged.manifest));
  }
  if (env.RELATIONSHIP_REFRESH !== "1" || (await activeRefreshFounder(env, fromSql(sql)))?.tenantId !== tenant.tenantId) return;
  const unchanged = (id: string) => async (current: Manifest) => await versionOf(current) === versions.get(id);
  // A mirror writes one side from the other: the side it read from is locked
  // and checked too, so a source reprocessed or purged since cannot be copied.
  const outcome = await pgReadingWriterFor(sql, tenant).replacePublishedSetIf(
    [...next].map(([id, manifest]) => ({ id, matches: unchanged(id), next: manifest })),
    [...manifests.keys()].filter(id => !next.has(id)).map(id => ({ id, matches: unchanged(id) })),
  );
  if (!outcome.replaced) logNoop("changed");
}
