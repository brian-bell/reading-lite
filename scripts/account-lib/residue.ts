/** Read-only observations, never deletion confirmation. Every source has its
 * own verdict; a failed read cannot erase evidence from another source.
 * DO storage has no operator read surface in this repository. Audit records
 * survive teardown intentionally; they are history, not a fresh clean bill.
 */
import type { ControlPlaneDb } from "../../src/control-plane/db";
import type { AuditVectors } from "./vectors";
import { enumerateNamespace } from "./vectors";
export interface ScanRemote {
  db: ControlPlaneDb;
  /** Closes the control-plane connection. The CLI sets an exit code rather
   *  than calling process.exit, so an open socket would hang the command. */
  closeDb?: () => Promise<void>;
  storage: {
    listObjects(prefix: string): Promise<{ key: string }[]>;
  };
  vectors: AuditVectors;
  probe(namespace: string): Promise<{ id: string }[]>;
}
export interface Finding {
  source: string;
  state: "clear" | "residue" | "expected" | "unknown";
  detail: unknown;
}
export async function scanResidue(remote: ScanRemote, tenant: string) {
  const findings: Finding[] = [];
  async function observe(
    source: string,
    action: () => Promise<Omit<Finding, "source">>,
  ) {
    try {
      findings.push({ source, ...(await action()) });
    } catch (err) {
      findings.push({
        source,
        state: "unknown",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const counted = (
    detail: unknown[],
    expected = false,
  ): Omit<Finding, "source"> => ({
    state: detail.length ? (expected ? "expected" : "residue") : "clear",
    detail,
  });
  await observe("account_deletions", async () => {
    const audit = await remote.db.first(
      "SELECT * FROM account_deletions WHERE tenant_id = ?",
      tenant,
    );
    return {
      state: audit ? "expected" : "unknown",
      detail:
        audit ??
        "No durable deletion audit; tenant may be live or teardown has not begun.",
    };
  });
  await observe("r2", async () =>
    counted(await remote.storage.listObjects(`u/${tenant}/`)),
  );
  await observe("legacy_wipe_record", async () =>
    counted(await remote.storage.listObjects(`wipe/${tenant}/`)),
  );
  // Retained pre-cutover Vectorize evidence, independent of the live PG corpus.
  await observe("namespace_probe", async () =>
    counted(await remote.probe(tenant)),
  );
  await observe("namespace_inventory", async () => {
    const inventory = await enumerateNamespace(remote.vectors, tenant);
    return {
      state: inventory.vectors.length
        ? "residue"
        : inventory.unknown.length
          ? "unknown"
          : "clear",
      detail: {
        ids: inventory.vectors.map((v) => v.id),
        enumerated: inventory.enumerated,
        pageCounts: inventory.pageCounts,
        unhydrated: inventory.unknown,
      },
    };
  });
  await observe("ready_reading_embeddings", async () => {
    // Ready does not imply searchable: non-owning duplicates and inactive
    // tenants can deliberately have no embedding. These are diagnostics, not
    // deletion residue; the independent pg.readings observation owns that.
    const detail = await remote.db.all<{ id: string }>(
      `SELECT r.id FROM readings r
       LEFT JOIN reading_embeddings e ON (e.tenant_id, e.reading_id) = (r.tenant_id, r.id)
       WHERE r.tenant_id = ? AND r.status = 'ready' AND e.reading_id IS NULL
       ORDER BY r.id`,
      tenant,
    );
    return { state: detail.length ? "unknown" : "clear", detail };
  });
  for (const [table, predicate, params] of [
    ["readings", "tenant_id = ?", [tenant]],
    ["reading_embeddings", "tenant_id = ?", [tenant]],
    ["corpus_refresh_state", "tenant_id = ?", [tenant]],
    ["relationship_refresh_jobs", "tenant_id = ?", [tenant]],
    ["users", "id = ?", [tenant]],
    ["sessions", "user_id = ?", [tenant]],
    ["api_tokens", "user_id = ?", [tenant]],
    [
      "api_token_scopes",
      "token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)",
      [tenant],
    ],
    ["user_settings", "user_id = ?", [tenant]],
    ["tenant_limits", "tenant_id = ?", [tenant]],
    ["digest_deliveries", "user_id = ?", [tenant]],
    ["wipe_progress", "tenant_id = ?", [tenant]],
    [
      "auth_challenges",
      "user_id = ? OR completed_user_id = ? OR (user_id IS NULL AND email_canonical IN (SELECT email_canonical FROM users WHERE id = ?))",
      [tenant, tenant, tenant],
    ],
    [
      "signup_invites",
      "email_canonical IN (SELECT email_canonical FROM users WHERE id = ?) OR (consumed_at IS NOT NULL AND email_canonical IN (SELECT email_canonical FROM auth_challenges WHERE user_id = ? OR completed_user_id = ?))",
      [tenant, tenant, tenant],
    ],
  ] as const) {
    await observe(`pg.${table}`, async () => {
      const rows = await remote.db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${predicate}`,
        ...params,
      );
      if (!rows[0] || !Number.isSafeInteger(rows[0].n) || rows[0].n < 0)
        throw new Error("count unavailable");
      return {
        state: rows[0].n ? "residue" : "clear",
        detail: { count: rows[0].n },
      };
    });
  }
  findings.push({
    source: "durable_objects",
    state: "unknown",
    detail:
      "Cannot inspect TenantUsageGuard storage/alarm or GlobalUsageGuard leases from this CLI. Bound DOs expose purge only, no operator read surface. Teardown's fail-closed purge is evidence, not a storage inspection.",
  });
  findings.push({
    source: "visibility_limits",
    state: "unknown",
    detail:
      "AuthRateGuard hashed email/IP windows cannot be attributed to a tenant. After teardown, erased address/token ownership prevents attribution of released-address invites, NULL-owner challenges, or orphan scopes. Consumed released-address invites may be inert S4 residuals. Queue/in-flight writes are not inspected. Global pre-cutover corpus is S7. Per-page vector counts are checked; totalCount is evidence only because its concurrent-mutation semantics are unspecified. Snapshot listing excludes later writes; hydration and per-id absence are single observations, not two spaced confirmations. Legacy Vectorize observations do not describe the live PostgreSQL corpus. Missing ready embeddings may be intentional; the scanner neither infers damage nor repairs them.",
  });
  return {
    tenant,
    findings,
    residue: findings.some((f) => f.state === "residue"),
    incomplete: findings.some((f) => f.state === "unknown"),
  };
}
