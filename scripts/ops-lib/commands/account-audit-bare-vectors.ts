import { parseArgs } from "node:util";
import { parseTenantId } from "../../../src/control-plane/ids";
import { parseReadingId } from "../../../src/services";
import { d1VectorLedger } from "../../account-lib/vector-ledger";
import { ListIndexSchema } from "../../../src/schemas/api";
import { readingIdFromRelativeKey } from "../../../src/account-wipe";
import { accountRemote } from "../../account-lib/remote";
import {
  bareRepairAction,
  enumerateNamespace,
  repairBareVector,
} from "../../account-lib/vectors";
import type { ScanRemote } from "../../account-lib/residue";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
interface Deps extends BaseDeps {
  connect(bucket: string): ScanRemote;
  now(): number;
}
export const accountAuditBareVectorsCommand: CommandDefinition<Deps> = {
  group: "account",
  name: "audit-bare-vectors",
  summary: "Enumerate tenant bare vectors and plan guarded duplicate repair",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- account audit-bare-vectors --namespace <usr_…> [--bucket reading-lite-staging]
  --execute --confirm <same tenant> --sole-writer
    Assert all realtime/offline writers AND wipe/teardown jobs are paused/drained.
Defaults to bucket reading-lite. Lists the entire index snapshot, retrieves IDs in
chunks <=20, then filters actual namespaces. Missing retrieval is UNKNOWN and
blocks execution. Reports bare/composed pairs including protected global copies.
Retained global R2 reading IDs and vectors without this namespace are refused;
legacy deletion belongs to S7. Active tenant repair ledgers before upsert, and
keeps the bare copy until a later run observes an identical composed payload.
Conflicting composed copies require review. Deleting/deleted tenant repair only
deletes tenant bare vectors; it never resurrects a composed copy. Delete requests
are asynchronous: re-audit later. Exit 1 while bare residue or unknowns remain.
Plan mode writes nothing. --help shows help.`,
  defaultDeps: (io) => ({ io, connect: accountRemote, now: Date.now }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          namespace: { type: "string" },
          bucket: { type: "string", default: "reading-lite" },
          execute: { type: "boolean" },
          confirm: { type: "string" },
          "sole-writer": { type: "boolean" },
        },
      }));
    } catch (e) {
      throw new UsageError(String(e));
    }
    const tenant = parseTenantId(values.namespace ?? "");
    if (!tenant) throw new UsageError("--namespace must be a usr_… tenant id");
    if (values.execute && (values.confirm !== tenant || !values["sole-writer"]))
      throw new UsageError(
        "--execute requires --confirm <same tenant> and --sole-writer (including wipe/teardown pause)",
      );
    const remote = deps.connect(values.bucket!);
    const inventory = await enumerateNamespace(remote.vectors, tenant);
    // Do not silently swallow corrupt retained-global inventory. It is a
    // protection boundary, not the wipe's intentionally over-inclusive seed.
    async function legacyIds() {
      const ids = new Set<string>();
      const raw = await remote.storage.get("index/list.json");
      if (raw !== null)
        for (const item of ListIndexSchema.parse(JSON.parse(raw)).items)
          ids.add(item.id);
      for (const prefix of ["index/by-id/", "readings/"]) {
        for (const object of await remote.storage.listObjects(prefix)) {
          if (!object.key.startsWith(prefix))
            throw new Error("global listing escaped prefix");
          const id = readingIdFromRelativeKey(object.key);
          if (id) ids.add(id);
        }
      }
      return ids;
    }
    async function tenantStatus() {
      const user = await remote.db.first<{ status: string }>(
        "SELECT status FROM users WHERE id = ?",
        tenant,
      );
      if (user) return user.status;
      const audit = await remote.db.first(
        "SELECT tenant_id FROM account_deletions WHERE tenant_id = ?",
        tenant,
      );
      return audit ? "deleted" : "unknown";
    }
    async function activeRepairableIds() {
      const raw = await remote.storage.get(`u/${tenant}/index/list.json`);
      const ready = new Set(
        raw === null
          ? []
          : ListIndexSchema.parse(JSON.parse(raw))
              .items.filter((item) => item.status === "ready")
              .map((item) => item.id),
      );
      const purging = await remote.db.all<{ reading_id: string }>(
        "SELECT reading_id FROM vector_ledger WHERE tenant_id = ? AND state = 'delete_submitted'",
        tenant,
      );
      for (const row of purging) ready.delete(row.reading_id);
      return ready;
    }
    const status = await tenantStatus();
    const legacy = await legacyIds();
    const bare = inventory.vectors.filter((v) => parseReadingId(v.id));
    const pairs: {
      reading: string;
      bareNamespace: string | null;
      protected: boolean;
    }[] = [];
    for (const vector of inventory.vectors.filter((v) =>
      v.id.startsWith(`${tenant}:`),
    )) {
      const id = vector.id.slice(tenant.length + 1);
      if (!parseReadingId(id)) continue;
      const match = (await remote.vectors.get([id])).find((v) => v.id === id);
      if (match)
        pairs.push({
          reading: id,
          bareNamespace: match.namespace ?? null,
          protected: match.namespace !== tenant || legacy.has(id),
        });
    }
    const unexpected = inventory.vectors
      .filter(
        (v) =>
          !parseReadingId(v.id) &&
          !(
            v.id.startsWith(`${tenant}:`) &&
            parseReadingId(v.id.slice(tenant.length + 1))
          ),
      )
      .map((v) => v.id);
    const repairable = status === "active" ? await activeRepairableIds() : null;
    const plan = bare.map((v) => ({
      bare: v.id,
      composed: `${tenant}:${v.id}`,
      protectedLegacy: legacy.has(v.id),
      action:
        repairable && !repairable.has(v.id)
          ? "refuse_unlisted_or_purging"
          : bareRepairAction(
              tenant,
              v,
              inventory.vectors.find(
                (target) => target.id === `${tenant}:${v.id}`,
              ),
              status,
              legacy.has(v.id),
            ),
    }));
    deps.io.stdout(
      JSON.stringify(
        {
          bucket: values.bucket,
          namespace: tenant,
          mode: values.execute ? "EXECUTE" : "PLAN",
          enumerated: inventory.enumerated,
          pageCounts: inventory.pageCounts,
          unknown: inventory.unknown,
          unexpected,
          pairs,
          status,
          plan,
          limits:
            "Index snapshot excludes later writes. Hydration is not atomic. Per-page counts are checked; totalCount is evidence only because its concurrent-mutation semantics are unspecified. Global/no-namespace vectors are protected. No absence here clears ledger rows. Production audit/repair is still required before #195 closes.",
        },
        null,
        2,
      ),
    );
    if (!values.execute)
      return bare.length || inventory.unknown.length || unexpected.length
        ? 1
        : 0;
    if (
      inventory.unknown.length ||
      unexpected.length ||
      plan.some((entry) => entry.action.startsWith("refuse_"))
    )
      throw new Error(
        "incomplete inventory, protected legacy vectors or unsafe plan: execution refused",
      );
    for (const vector of bare) {
      if ((await legacyIds()).has(vector.id))
        throw new Error("legacy membership changed since plan");
      const status = await tenantStatus();
      if (status === "active" && !(await activeRepairableIds()).has(vector.id))
        throw new Error(
          "active reading is unlisted, not ready, or awaiting purge confirmation",
        );
      const ledger = d1VectorLedger(remote.db, tenant);
      const result = await repairBareVector(remote.vectors, tenant, vector, {
        status,
        legacy: false,
        ledger: (id) => ledger.markLive([id], deps.now()),
      });
      deps.io.stdout(JSON.stringify({ id: vector.id, result }));
    }
    deps.io.stdout(
      "Mutations submitted only. Keep writers paused; re-audit after propagation. No ledger rows were cleared.",
    );
    return bare.length ? 1 : 0;
  },
};
