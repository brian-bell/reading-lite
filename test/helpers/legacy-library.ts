// An in-memory legacy source for the library importer (reading-lite-gh348):
// an R2 bucket holding a tenant's manifests, attempt logs, pointers and
// content in the manifest-era layout, a Vectorize index answering get_by_ids,
// and D1 control-plane tables. Every read is recorded, so tests can assert
// what the export touched.

import { createHash } from "node:crypto";
import type { Manifest } from "../../src/schemas/manifest";
import type { R2ObjectMeta } from "../../scripts/lib/cf-clients";
import type { D1TableRead, ReadOnlyBucket, ReadOnlyVectors, SourceVector } from "../../scripts/migrate-lib/sources";

export const LEGACY_TENANT = "usr_11111111-1111-4111-8111-111111111111";
export const OTHER_TENANT = "usr_22222222-2222-4222-8222-222222222222";

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

export function unitVector(seed: number): number[] {
  const values = Array.from({ length: 1536 }, (_, i) => Math.sin(seed * 7.1 + i * 0.37));
  const norm = Math.hypot(...values);
  return values.map((v) => v / norm);
}

export interface ReadingSpec {
  id: string;
  url?: string;
  status?: Manifest["status"];
  createdAt?: string;
  manifest?: Partial<Manifest> & Record<string, unknown>;
  /** The raw bytes as stored; null for none. Default: some HTML. */
  raw?: string | null;
  /** Stored raw bytes that differ from what the manifest hashed. */
  rawOnDisk?: string;
  extracted?: string | null;
  /** Stores the raw object under this name instead of raw.html. */
  rawName?: string;
  vector?: "ok" | "missing" | "flaky" | "invalid";
  pointer?: boolean;
  listed?: boolean;
  attempts?: Record<string, unknown>[];
  tenant?: string;
}

export class LegacyLibrary {
  readonly objects = new Map<string, Uint8Array>();
  readonly vectorIndex = new Map<string, SourceVector>();
  // Ids get_by_ids drops from a multi-id batch but returns on its own (the
  // founder-cutover failure).
  readonly flaky = new Set<string>();
  readonly tables: Record<string, Record<string, unknown>[]> = {};
  readonly gets: string[] = [];
  readonly listed: string[] = [];
  readonly vectorRequests: string[][] = [];
  readonly d1Reads: D1TableRead[] = [];
  readonly listItems: Record<string, unknown>[] = [];

  constructor(readonly tenantId = LEGACY_TENANT) {
    this.tables = controlPlaneRows(tenantId);
  }

  put(key: string, body: string | Uint8Array): void {
    this.objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
  }

  putJson(key: string, value: unknown): void {
    this.put(key, JSON.stringify(value));
  }

  prefixFor(id: string, createdAt = "2026-03-01T10:00:00.000Z"): string {
    const compact = createdAt.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/, "$1/$2/$3T$4$5$6Z");
    return `readings/${compact}-${id}`;
  }

  /** Adds one reading in the manifest-era layout and returns its manifest. */
  addReading(spec: ReadingSpec): Manifest & Record<string, unknown> {
    const tenant = spec.tenant ?? this.tenantId;
    const root = tenant === "" ? "" : `u/${tenant}/`;
    const status = spec.status ?? "ready";
    const url = spec.url ?? `https://example.com/${spec.id}`;
    const createdAt = spec.createdAt ?? "2026-03-01T10:00:00.000Z";
    const prefix = this.prefixFor(spec.id, createdAt);
    const raw = spec.raw === undefined ? `<html><body>${spec.id}</body></html>` : spec.raw;
    const extracted = spec.extracted === undefined ? `# ${spec.id}\n\nBody of ${spec.id}.` : spec.extracted;
    const manifest = {
      id: spec.id,
      url,
      url_hash: sha256(url),
      source_type: "url",
      status,
      content_type: "text/html; charset=utf-8",
      content_status: raw === null ? "failed" : "captured",
      content_bytes: raw === null ? 0 : new TextEncoder().encode(raw).byteLength,
      content_sha256: sha256(raw ?? ""),
      ...(raw !== null && extracted !== null ? { extracted_bytes: new TextEncoder().encode(extracted).byteLength } : {}),
      created_at: createdAt,
      updated_at: createdAt,
      ...(status === "ready"
        ? { title: `Title ${spec.id}`, tldr: `Summary of ${spec.id}.`, tags: ["migration"], summary_markdown: `About ${spec.id}.`, connections: [] }
        : {}),
      ...(status === "failed" ? { error: { code: "fetch_failed", message: "upstream 500" } } : {}),
      ...spec.manifest,
    } as Manifest & Record<string, unknown>;
    this.putJson(`${root}${prefix}/manifest.json`, manifest);
    if (raw !== null) this.put(`${root}${prefix}/${spec.rawName ?? "raw.html"}`, spec.rawOnDisk ?? raw);
    if (raw !== null && extracted !== null) this.put(`${root}${prefix}/extracted.md`, extracted);
    for (const attempt of spec.attempts ?? []) this.putJson(`${root}${prefix}/attempts/${String(attempt.id)}.json`, attempt);
    if (spec.pointer ?? true) this.putJson(`${root}index/by-url/${manifest.url_hash}`, { id: spec.id, key_prefix: prefix });
    this.put(`${root}index/by-id/${spec.id}`, JSON.stringify({ id: spec.id, key_prefix: prefix }));
    if (spec.listed ?? true) {
      this.listItems.push({ id: spec.id, key_prefix: prefix, url, status, created_at: createdAt, updated_at: createdAt });
      this.putJson(`${root}index/list.json`, { version: 1, items: this.listItems });
    }
    const vectorId = tenant === "" ? spec.id : `${tenant}:${spec.id}`;
    const vector = spec.vector ?? (status === "ready" ? "ok" : "missing");
    if (vector !== "missing") {
      this.vectorIndex.set(vectorId, {
        id: vectorId,
        values: vector === "invalid" ? [1, 2, 3] : unitVector(spec.id.length + spec.id.charCodeAt(spec.id.length - 1)),
        ...(tenant === "" ? {} : { namespace: tenant }),
      });
      if (vector === "flaky") this.flaky.add(vectorId);
    }
    if (status === "ready" && tenant === this.tenantId) {
      this.tables.vector_ledger!.push({ tenant_id: tenant, reading_id: spec.id, state: "live", upserted_at_ms: 1, deleted_at_ms: null, absent_streak: 0, last_absent_at_ms: null });
    }
    return manifest;
  }

  attempt(readingId: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const url = `https://example.com/${readingId}`;
    return {
      id,
      reading_id: readingId,
      url,
      url_hash: sha256(url),
      key_prefix: this.prefixFor(readingId),
      trigger: "submit",
      status: "succeeded",
      started_at: "2026-03-01T10:00:00.000Z",
      finished_at: "2026-03-01T10:00:05.000Z",
      events: [{ stage: "fetch_source", status: "succeeded", at: "2026-03-01T10:00:01.000Z", duration_ms: 1000 }],
      ...overrides,
    };
  }

  bucket(): ReadOnlyBucket {
    return {
      list: async (prefix) => {
        this.listed.push(prefix);
        return [...this.objects]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, body]): R2ObjectMeta => ({ key, size: body.byteLength, etag: sha256(body).slice(0, 32) }));
      },
      get: async (key) => {
        this.gets.push(key);
        return this.objects.get(key) ?? null;
      },
    };
  }

  vectors(): ReadOnlyVectors {
    return {
      getByIds: async (ids) => {
        this.vectorRequests.push([...ids]);
        return ids
          .filter((id) => this.vectorIndex.has(id) && !(ids.length > 1 && this.flaky.has(id)))
          .map((id) => this.vectorIndex.get(id)!);
      },
    };
  }

  readD1 = async (spec: D1TableRead): Promise<Record<string, unknown>[]> => {
    this.d1Reads.push(spec);
    if (spec.table === "sqlite_master") {
      return ["d1_migrations", "_cf_KV", ...Object.keys(this.tables)].sort().map((name) => ({ type: "table", name }));
    }
    const rows = this.tables[spec.table];
    if (!rows) throw new Error(`no such table: ${spec.table}`);
    return rows.map((row) => ({ ...row }));
  };

  source() {
    return { bucket: this.bucket(), vectors: this.vectors(), readD1: this.readD1 };
  }
}

const HMAC = (n: number) => sha256(`secret-${n}`);

/** A small, valid D1 control plane: one active founder, a second account, one torn-down one. */
export function controlPlaneRows(tenantId: string): Record<string, Record<string, unknown>[]> {
  const t0 = 1_767_225_600_123; // 2026-01-01T00:00:00.123Z
  return {
    users: [
      { id: tenantId, email_canonical: "founder@example.com", email_display: "Founder@example.com", status: "active", email_verified_at_ms: t0, created_at_ms: t0, updated_at_ms: t0 + 1, suspended_at_ms: null, deleting_at_ms: null },
      { id: OTHER_TENANT, email_canonical: "other@example.com", email_display: "other@example.com", status: "suspended", email_verified_at_ms: null, created_at_ms: t0, updated_at_ms: t0, suspended_at_ms: t0 + 5, deleting_at_ms: null },
    ],
    user_settings: [
      { user_id: tenantId, schema_version: 1, notify_immediate: 1, digest_cadence: "weekly", time_zone: "America/New_York", digest_hour_local: 7, digest_weekday: 1, created_at_ms: t0, updated_at_ms: t0 },
    ],
    tenant_limits: [
      { tenant_id: tenantId, policy_version: 3, submissions_per_hour: 30, monthly_readings: 500, max_concurrent_work: 3, daily_spend_microdollars: 5_000_000_000, created_at_ms: t0, updated_at_ms: t0 },
    ],
    api_tokens: [
      { id: "tok_33333333-3333-4333-8333-333333333333", user_id: tenantId, name: "legacy", format: "legacy", secret_hmac: HMAC(1), hash_key_version: 1, created_at_ms: t0, expires_at_ms: t0 + 86_400_000_000, revoked_at_ms: null, last_used_at_ms: t0 + 99, user_agent_label: "curl" },
    ],
    api_token_scopes: [
      { token_id: "tok_33333333-3333-4333-8333-333333333333", scope: "readings:read" },
      { token_id: "tok_33333333-3333-4333-8333-333333333333", scope: "readings:write" },
    ],
    system_policy: [
      { id: 1, signup_mode: "closed", paid_work_enabled: 1, policy_version: 3, catalog_version: 2, updated_at_ms: t0, max_concurrent_work: 3, daily_spend_microdollars: null },
    ],
    sessions: [
      { id: "ses_44444444-4444-4444-8444-444444444444", user_id: tenantId, secret_hmac: HMAC(2), hash_key_version: 1, created_at_ms: t0, authenticated_at_ms: t0, last_seen_at_ms: t0 + 7, idle_expires_at_ms: t0 + 1e9, absolute_expires_at_ms: t0 + 2e9, revoked_at_ms: null, revocation_reason: null, user_agent_label: "Safari", created_from_claim_id: "claim-1" },
    ],
    auth_challenges: [
      { issue_seq: 1, id: "ml_55555555-5555-4555-8555-555555555551", purpose: "login", email_canonical: "founder@example.com", email_display: "Founder@example.com", user_id: tenantId, secret_hmac: HMAC(3), hash_key_version: 1, issued_at_ms: t0, expires_at_ms: t0 + 900_000, state: "consumed", claim_id: "claim-1", claimed_at_ms: t0 + 10, consumed_at_ms: t0 + 11, completed_user_id: tenantId, completed_session_id: "ses_44444444-4444-4444-8444-444444444444", mail_sent_at_ms: t0 + 1, bound_session_id: null },
      { issue_seq: 7, id: "ml_55555555-5555-4555-8555-555555555552", purpose: "login", email_canonical: "founder@example.com", email_display: "Founder@example.com", user_id: tenantId, secret_hmac: HMAC(4), hash_key_version: 1, issued_at_ms: t0 + 50, expires_at_ms: t0 + 900_050, state: "revoked", claim_id: null, claimed_at_ms: null, consumed_at_ms: null, completed_user_id: null, completed_session_id: null, mail_sent_at_ms: null, bound_session_id: null },
    ],
    signup_invites: [
      { email_canonical: "friend@example.com", email_display: "Friend@example.com", created_at_ms: t0, expires_at_ms: null, consumed_at_ms: null },
    ],
    dev_mail_outbox: [],
    digest_deliveries: [
      { user_id: tenantId, cadence: "weekly", period_key: "2026-W02", status: "sent", skip_reason: null, created_at_ms: t0, updated_at_ms: t0 + 3, resend_id: "re_123" },
    ],
    relationship_refresh_jobs: [
      { tenant_id: tenantId, reading_id: "rd_READY0001", run_at: "2026-03-02T03:07:00.000Z", owner: "run-1", source_etag: "etag-1", result_json: '{"verdict":"unchanged","ids":["rd_READY0002"]}', retry_at_ms: null },
    ],
    wipe_progress: [
      { tenant_id: OTHER_TENANT, phase: "done", lease_seq: 4, updated_at_ms: t0 + 9, vector_cursor: null, r2_cursor: null, force: 0, objects_deleted: 12, mutation_ids: "[]", index_count_sampled: 1, index_count_start: 40, probe_attempts: 0, probe_saw_residue: 0, continuations: 0, completed_at_ms: t0 + 9, residue: 0, first_completed_at_ms: t0 + 9, first_residue: 0, seed_cursor: null, seed_completed_at_ms: t0 + 2 },
    ],
    account_deletions: [
      { tenant_id: "usr_99999999-9999-4999-8999-999999999999", deleting_at_ms: null, completed_at_ms: t0, residue: 1, first_completed_at_ms: t0, first_residue: 1, torn_down_at_ms: t0 + 1 },
    ],
    vector_ledger: [],
  };
}

/**
 * One of each case the export has to reconcile, in a tenant library that also
 * sits beside global (pre-tenant) data and another tenant's library.
 */
export function buildLegacyCorpus(lib: LegacyLibrary): void {
  const T = lib.tenantId;
  const sharedUrl = "https://example.com/shared";
  lib.addReading({
    id: "rd_READY0001",
    url: sharedUrl,
    manifest: {
      connections: [
        { id: "rd_READY0002", reason: "same topic" },
        { id: "rd_GONE00001", reason: "purged since" },
      ],
      connections_computed_at: "2026-03-02T00:00:00.000Z",
    },
    attempts: [lib.attempt("rd_READY0001", "att_1")],
  });
  lib.addReading({
    id: "rd_READY0002",
    createdAt: "2026-03-01T10:00:00Z",
    vector: "flaky",
    manifest: { legacy_field: "kept only in the report", preserve_ready_manifest: { old: true } },
  });
  lib.addReading({ id: "rd_READY0003", vector: "missing" });
  lib.addReading({ id: "rd_FAIL00001", url: sharedUrl, status: "failed", raw: null, pointer: false, vector: "ok", createdAt: "2026-03-03T10:00:00.000Z" });
  lib.addReading({
    id: "rd_PEND00001",
    status: "pending",
    raw: null,
    listed: false,
    manifest: {
      active_attempt: { id: "att_p", trigger: "submit", status: "running", started_at: "2026-03-01T10:00:00.000Z" },
    },
    attempts: [lib.attempt("rd_PEND00001", "att_p", { status: "running", finished_at: undefined })],
  });
  lib.addReading({ id: "rd_HASH00001", rawOnDisk: "<html>rewritten by a later attempt</html>", extracted: null });
  lib.addReading({ id: "rd_TOMB00001" });
  // Raw bytes stored under a spelling content_type does not imply.
  lib.addReading({ id: "rd_RAWEXT001", rawName: "raw.bin" });
  lib.put(`u/${T}/index/deleted/rd_TOMB00001`, "");
  // A manifest ManifestSchema rejects.
  lib.putJson(`u/${T}/${lib.prefixFor("rd_BAD000001")}/manifest.json`, { id: "rd_BAD000001", status: "ready" });
  // A list row with no manifest behind it.
  lib.listItems.push({ id: "rd_LISTONLY1", key_prefix: lib.prefixFor("rd_LISTONLY1"), url: "https://example.com/l", status: "ready", created_at: "2026-03-01T10:00:00.000Z", updated_at: "2026-03-01T10:00:00.000Z" });
  lib.putJson(`u/${T}/index/list.json`, { version: 1, items: lib.listItems });
  // A ledger row claiming a live vector for a reading that is not ready.
  lib.tables.vector_ledger!.push({ tenant_id: T, reading_id: "rd_FAIL00001", state: "live", upserted_at_ms: 1, deleted_at_ms: null, absent_streak: 0, last_absent_at_ms: null });
  // Data the export must never read.
  lib.addReading({ id: "rd_GLOBAL001", tenant: "" });
  lib.addReading({ id: "rd_OTHER0001", tenant: OTHER_TENANT });
}
