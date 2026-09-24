// `ops migrate export`'s body (reading-lite-gh348): read one tenant's legacy
// library and the D1 control plane, reconcile them, and assemble a snapshot.
//
// The inventory is the tenant's MANIFESTS, found by listing every object
// under `u/{tenant}/`, not index/list.json: the list is a CAS-maintained
// derivative that can miss a reading or keep a row for one that is gone, and
// both are reported rather than trusted. Listing only under the tenant root
// is also what excludes the retained pre-tenant global data (bare
// `readings/…` keys and unnamespaced vectors): nothing outside that root is
// read, and vectors are fetched by their composed `{tenant}:{id}` ids only.
//
// Nothing here writes. Plan mode stops after collectExport; --execute embeds
// the vector misses (the only paid call) and writes the snapshot.

import { ByUrlPointerSchema, ProcessingAttemptSchema, type Manifest } from "../../src/schemas/manifest";
import { ListIndexSchema } from "../../src/schemas/api";
import { compareUrlOwnership, manifestToRows } from "../pg-lib/manifest-rows";
import { rawExtFromContentType } from "../../src/modules/stores/layout";
import { CONTROL_PLANE_TABLES, VECTOR_LEDGER_TABLE } from "./control-plane-map";
import {
  blockingIssues,
  countByCode,
  expectedManifest,
  fieldTotals,
  parseEntry,
  respelledTimestamps,
  sortDiscrepancies,
  vectorProblem,
  type Discrepancy,
} from "./library-checks";
import { canonicalHash, sha256Text, type ControlPlaneSnapshot, type Library, type LibraryEntry } from "./snapshot";
import type { ReadD1Table, ReadOnlyBucket, ReadOnlyVectors } from "./sources";
import { mapWithConcurrency } from "../lib/concurrency";

// Parallel R2 reads. The corpus is thousands of small GETs (manifests, attempt
// logs, pointers, raw content to hash) with nothing depending on anything else;
// every result is collected by key and reconciled in a sequential pass after,
// so the report does not depend on completion order.
const READ_CONCURRENCY = 8;

export interface ExportDeps {
  bucket: ReadOnlyBucket;
  vectors: ReadOnlyVectors;
  readD1: ReadD1Table;
  /** Progress lines for the operator (stderr). */
  progress?: (line: string) => void;
}

export interface ReembedTarget {
  id: string;
  tldr: string;
}

export interface ExportCollection {
  library: Library;
  controlPlane: ControlPlaneSnapshot;
  report: ExportReport;
  /** Ready readings get_by_ids did not return, to embed from their tldr on --execute. */
  reembed: ReembedTarget[];
}

export interface ExportReport {
  version: 1;
  tenant_id: string;
  totals: Record<string, number>;
  discrepancy_counts: Record<string, number>;
  field_totals: Record<string, { present: number; sha256: string }>;
  ids: string[];
  manifest_sha256: Record<string, string>;
  duplicate_url_owners: { url_hash: string; url: string; owner: string; others: string[] }[];
  unresolved_pending: { id: string; status: string; active_attempt: string | null }[];
  tombstones: string[];
  vectors: {
    found: number;
    reembedded: string[];
    invalid: string[];
    non_ready: string[];
    non_owner: string[];
    retried_individually: string[];
  };
  blocking: Discrepancy[];
  discrepancies: Discrepancy[];
}

const MANIFEST_SUFFIX = "/manifest.json";

type ObjectKind = "manifest" | "extracted" | "raw" | "attempt" | "processing" | "other";

function classify(rest: string): ObjectKind {
  if (rest === "manifest.json") return "manifest";
  if (rest === "extracted.md") return "extracted";
  if (/^raw\.[^/]+$/.test(rest)) return "raw";
  if (/^attempts\/[^/]+\.json$/.test(rest)) return "attempt";
  if (/^processing\/[^/]+\.json$/.test(rest)) return "processing";
  return "other";
}

function decodeJson(bytes: Uint8Array | null): { ok: true; value: unknown } | { ok: false; error: string } {
  if (bytes === null) return { ok: false, error: "object vanished between list and get" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (error) {
    return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function collectExport(tenantId: string, deps: ExportDeps): Promise<ExportCollection> {
  const progress = deps.progress ?? (() => {});
  const root = `u/${tenantId}/`;
  const discrepancies: Discrepancy[] = [];
  const note = (d: Discrepancy) => discrepancies.push(d);

  progress(`Listing ${root} …`);
  const objects = await deps.bucket.list(root);
  const outside = objects.filter((o) => !o.key.startsWith(root));
  if (outside.length > 0) {
    // The listing is the isolation boundary; a client that ignored the prefix
    // would otherwise pull another tenant's (or the global) data in.
    throw new Error(`R2 listing for ${root} returned ${outside.length} key(s) outside it, e.g. ${outside[0]!.key}`);
  }
  const rel = (key: string) => key.slice(root.length);

  // Reading prefixes are the directories holding a manifest.json.
  const prefixes = objects
    .map((o) => rel(o.key))
    .filter((key) => key.startsWith("readings/") && key.endsWith(MANIFEST_SUFFIX))
    .map((key) => key.slice(0, -MANIFEST_SUFFIX.length))
    .sort();
  const prefixSet = new Set(prefixes);
  const byPrefix = new Map<string, { rest: string; kind: ObjectKind; size: number }[]>(prefixes.map((p) => [p, []]));
  const byUrl: string[] = [];
  const byId = new Set<string>();
  const tombstones: string[] = [];
  let listIndexKey: string | null = null;
  const orphans = new Map<string, number>();

  for (const object of objects) {
    const key = rel(object.key);
    if (key === "index/list.json") listIndexKey = object.key;
    else if (key.startsWith("index/by-url/")) byUrl.push(key.slice("index/by-url/".length));
    else if (key.startsWith("index/by-id/")) byId.add(key.slice("index/by-id/".length));
    else if (key.startsWith("index/deleted/")) tombstones.push(key.slice("index/deleted/".length));
    else if (key === "index/refresh-state.json") {
      note({ code: "refresh_state_not_imported", key, detail: "operator refresh marker; the next refresh pass sweeps the whole library" });
    } else if (key === "index/refresh-cursor.json") {
      // The hosted nightly cursor stays in R2 and is still read there.
    } else if (key.startsWith("readings/")) {
      let owner: string | null = null;
      for (let at = key.lastIndexOf("/"); at > 0; at = key.lastIndexOf("/", at - 1)) {
        if (prefixSet.has(key.slice(0, at))) {
          owner = key.slice(0, at);
          break;
        }
      }
      if (owner === null) {
        const group = key.split("/").slice(0, 4).join("/");
        orphans.set(group, (orphans.get(group) ?? 0) + 1);
        continue;
      }
      const rest = key.slice(owner.length + 1);
      byPrefix.get(owner)!.push({ rest, kind: classify(rest), size: object.size });
    } else {
      note({ code: "unexpected_object", key });
    }
  }
  byUrl.sort();
  for (const [group, count] of orphans) {
    note({ code: "orphan_objects", key: group, detail: `${count} object(s) under a prefix with no manifest.json` });
  }
  tombstones.sort();

  // Every small object the reconciliation reads, fetched up front; raw content
  // is hashed as it arrives rather than held, since it can be megabytes each.
  const jsonKeys = [
    ...prefixes.flatMap((prefix) => [
      `${root}${prefix}${MANIFEST_SUFFIX}`,
      ...byPrefix.get(prefix)!.filter((m) => m.kind === "attempt").map((m) => `${root}${prefix}/${m.rest}`),
    ]),
    ...byUrl.map((hash) => `${root}index/by-url/${hash}`),
    ...(listIndexKey === null ? [] : [listIndexKey]),
  ];
  const rawKeys = prefixes.flatMap((prefix) =>
    byPrefix.get(prefix)!.filter((m) => m.kind === "raw").map((m) => `${root}${prefix}/${m.rest}`),
  );
  progress(`Reading ${jsonKeys.length} manifest, attempt and pointer object(s) and hashing ${rawKeys.length} raw object(s) …`);
  const bodies = new Map<string, Uint8Array | null>();
  const hashes = new Map<string, string | null>();
  await mapWithConcurrency(jsonKeys, READ_CONCURRENCY, async (key) => bodies.set(key, await deps.bucket.get(key)));
  await mapWithConcurrency(rawKeys, READ_CONCURRENCY, async (key) => {
    const bytes = await deps.bucket.get(key);
    hashes.set(key, bytes === null ? null : sha256Text(bytes));
  });
  const body = (key: string) => bodies.get(key) ?? null;

  const readings: LibraryEntry[] = [];
  const parsedById = new Map<string, { entry: LibraryEntry; manifest: Manifest }>();
  let attemptCount = 0;
  let checkpointCount = 0;
  let contentBytes = 0;

  for (const prefix of prefixes) {
    const decoded = decodeJson(body(`${root}${prefix}${MANIFEST_SUFFIX}`));
    const idFromPrefix = /-(rd_[^/]+)$/.exec(prefix)?.[1];
    const rawManifest = decoded.ok ? decoded.value : null;
    const id =
      rawManifest && typeof rawManifest === "object" && typeof (rawManifest as { id?: unknown }).id === "string"
        ? (rawManifest as { id: string }).id
        : (idFromPrefix ?? prefix);
    const entry: LibraryEntry = { id, key_prefix: prefix, manifest: rawManifest, owns_url: false, attempts: [], embedding: null };
    readings.push(entry);
    if (!decoded.ok) continue; // blockingIssues reports it as malformed_manifest
    const parsed = parseEntry(entry);
    if (!parsed.ok) continue;
    const manifest = parsed.manifest;
    if (!parsedById.has(id)) parsedById.set(id, { entry, manifest });

    if (parsed.strippedFields.length > 0) {
      note({ code: "stripped_fields", id, detail: `not in ManifestSchema, not imported: ${parsed.strippedFields.join(", ")}` });
    }
    const respelled = respelledTimestamps(manifest);
    if (respelled.fields.length > 0) {
      note({
        code: respelled.precisionLost ? "timestamp_precision_lost" : "timestamp_respelled",
        id,
        detail: respelled.fields.join(", "),
      });
    }
    for (const mapping of manifestToRows(manifest, { tenantId, keyPrefix: prefix, ownsUrl: false }).notes) {
      note({ code: "mapping_note", id, detail: mapping });
    }

    // Objects under the reading prefix.
    const members = byPrefix.get(prefix)!;
    const attempts: { started_at: string; id: string; value: unknown }[] = [];
    for (const member of members) {
      if (member.kind === "attempt") {
        const attempt = decodeJson(body(`${root}${prefix}/${member.rest}`));
        const parsedAttempt = attempt.ok ? ProcessingAttemptSchema.safeParse(attempt.value) : null;
        if (!parsedAttempt?.success) {
          note({ code: "malformed_attempt", id, key: `${prefix}/${member.rest}`, detail: attempt.ok ? parsedAttempt!.error.message : attempt.error });
        } else if (parsedAttempt.data.reading_id !== id) {
          note({ code: "malformed_attempt", id, key: `${prefix}/${member.rest}`, detail: `reading_id ${parsedAttempt.data.reading_id}` });
        } else {
          attempts.push({ started_at: parsedAttempt.data.started_at, id: parsedAttempt.data.id, value: parsedAttempt.data });
        }
      } else if (member.kind === "processing") {
        checkpointCount++;
        note({ code: "processing_checkpoint_not_imported", id, key: `${prefix}/${member.rest}` });
      } else if (member.kind === "other") {
        note({ code: "unexpected_object", id, key: `${prefix}/${member.rest}` });
      }
    }
    attempts.sort((a, b) => (a.started_at === b.started_at ? (a.id < b.id ? -1 : 1) : a.started_at < b.started_at ? -1 : 1));
    entry.attempts = attempts.map((a) => a.value);
    attemptCount += attempts.length;
    const logged = new Set(attempts.map((a) => a.id));
    for (const summary of [manifest.active_attempt, manifest.last_attempt]) {
      if (summary && !logged.has(summary.id)) {
        note({ code: "attempt_log_missing", id, detail: `attempt ${summary.id} is summarised on the manifest but has no attempts/ log` });
      }
    }

    // Content, as the imported revision (legacy spelling) will address it.
    const expectedRest = `raw.${rawExtFromContentType(manifest.content_type)}`;
    const others = members.filter((m) => m.kind === "raw" && m.rest !== expectedRest);
    // When the expected spelling is absent but exactly one other raw object is
    // there, the imported revision addresses that one, so /content/raw finds
    // bytes rather than a key that does not exist.
    const raw =
      members.find((m) => m.rest === expectedRest) ??
      (others.length === 1 && manifest.status === "ready" ? others[0] : undefined);
    const rawRest = raw?.rest ?? expectedRest;
    // Only a ready reading gets a revision to carry the found key; the others
    // are read at the legacy spelling, so for them it stays content_missing.
    if (raw && raw.rest !== expectedRest && manifest.status === "ready") {
      entry.raw_key = `${prefix}/${raw.rest}`;
      note({
        code: "content_key_mismatch",
        id,
        key: `${prefix}/${raw.rest}`,
        detail: `content_type implies ${expectedRest}; the imported revision addresses ${raw.rest}`,
      });
    }
    if (!raw) {
      if (manifest.content_status !== "failed") {
        note({
          code: "content_missing",
          id,
          key: `${prefix}/${expectedRest}`,
          detail: others.length > 0 ? `found ${others.map((m) => m.rest).join(", ")} instead` : "raw object absent",
        });
      }
    } else {
      contentBytes += raw.size;
      if (raw.size !== manifest.content_bytes) {
        note({ code: "content_size_mismatch", id, key: `${prefix}/${rawRest}`, detail: `object ${raw.size} bytes, manifest ${manifest.content_bytes}` });
      }
      const hash = hashes.get(`${root}${prefix}/${rawRest}`) ?? null;
      if (hash === null) {
        note({ code: "content_missing", id, key: `${prefix}/${rawRest}`, detail: "object vanished between list and get" });
      } else if (hash !== manifest.content_sha256) {
        note({ code: "content_hash_mismatch", id, key: `${prefix}/${rawRest}`, detail: `sha256 ${hash}, manifest ${manifest.content_sha256}` });
      }
    }
    const extracted = members.find((m) => m.kind === "extracted");
    if (manifest.content_status === "captured") {
      if (!extracted) {
        note({ code: "content_missing", id, key: `${prefix}/extracted.md`, detail: "extracted object absent" });
      } else if (manifest.extracted_bytes !== undefined && extracted.size !== manifest.extracted_bytes) {
        note({
          code: "content_size_mismatch",
          id,
          key: `${prefix}/extracted.md`,
          detail: `object ${extracted.size} bytes, manifest ${manifest.extracted_bytes}`,
        });
      }
    }
  }

  const manifests = [...parsedById.values()];
  const ids = new Set(manifests.map((m) => m.manifest.id));

  // URL ownership. The by-url pointer decides. A reading whose url_hash is not
  // the hash of its url is blocking (blockingIssues: url_hash_mismatch).
  const pointers = new Map<string, { id: string; key_prefix: string }>();
  for (const hash of byUrl) {
    const decoded = decodeJson(body(`${root}index/by-url/${hash}`));
    const pointer = decoded.ok ? ByUrlPointerSchema.safeParse(decoded.value) : null;
    if (!pointer?.success) {
      note({ code: "url_pointer_malformed", key: `index/by-url/${hash}` });
      continue;
    }
    pointers.set(hash, pointer.data);
  }
  const groups = new Map<string, Manifest[]>();
  for (const { manifest } of manifests) {
    groups.set(manifest.url_hash, [...(groups.get(manifest.url_hash) ?? []), manifest]);
  }
  const duplicateOwners: ExportReport["duplicate_url_owners"] = [];
  for (const [hash, members] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const pointer = pointers.get(hash);
    let owner: Manifest | undefined;
    if (pointer === undefined) {
      note({ code: "url_pointer_missing", id: members[0]!.id, key: `index/by-url/${hash}`, detail: "owner chosen by status, then newest" });
    } else {
      owner = members.find((m) => m.id === pointer.id);
      if (owner === undefined) {
        note({ code: "url_pointer_dangling", key: `index/by-url/${hash}`, detail: `points at ${pointer.id}, which does not hold this URL; owner chosen by status, then newest` });
      } else if (parsedById.get(owner.id)!.entry.key_prefix !== pointer.key_prefix) {
        note({ code: "url_pointer_mismatch", id: owner.id, key: `index/by-url/${hash}`, detail: `pointer key_prefix ${pointer.key_prefix}` });
      }
    }
    // A tombstoned copy is only ever skipped at import, so it cannot keep the
    // URL: the surviving copy owns it, and with it the vector.
    const purged = new Set(tombstones);
    if (owner !== undefined && purged.has(owner.id) && members.some((m) => !purged.has(m.id))) {
      note({ code: "url_owner_tombstoned", id: owner.id, key: `index/by-url/${hash}`, detail: "owner chosen among the copies that were not purged" });
      owner = undefined;
    }
    owner ??= [...members].sort((a, b) => Number(purged.has(a.id)) - Number(purged.has(b.id)) || compareUrlOwnership(a, b))[0]!;
    parsedById.get(owner.id)!.entry.owns_url = true;
    if (members.length > 1) {
      const others = members.filter((m) => m.id !== owner!.id).map((m) => m.id).sort();
      duplicateOwners.push({ url_hash: hash, url: owner.url, owner: owner.id, others });
      note({ code: "duplicate_url", id: owner.id, detail: `also held by ${others.join(", ")}` });
    }
  }
  for (const hash of pointers.keys()) {
    if (!groups.has(hash)) note({ code: "url_pointer_dangling", key: `index/by-url/${hash}`, detail: `points at ${pointers.get(hash)!.id}; no manifest holds this URL` });
  }
  for (const id of [...ids].sort()) if (!byId.has(id)) note({ code: "id_pointer_missing", id });
  for (const id of [...byId].sort()) if (!ids.has(id)) note({ code: "id_pointer_dangling", id, key: `index/by-id/${id}` });

  // The list index, compared against the manifests it is derived from.
  if (listIndexKey === null) {
    note({ code: "list_index_missing", key: "index/list.json" });
  } else {
    const decoded = decodeJson(body(listIndexKey));
    const list = decoded.ok ? ListIndexSchema.safeParse(decoded.value) : null;
    if (!list?.success) {
      note({ code: "list_index_malformed", key: "index/list.json" });
    } else {
      const rows = new Map(list.data.items.map((item) => [item.id, item]));
      for (const { manifest, entry } of manifests) {
        const row = rows.get(manifest.id);
        if (!row) {
          note({ code: "list_row_missing", id: manifest.id });
          continue;
        }
        const differs = (["url", "status", "created_at"] as const).filter((f) => row[f] !== manifest[f]);
        if (row.key_prefix !== entry.key_prefix) differs.push("key_prefix" as never);
        if (differs.length > 0) note({ code: "list_row_mismatch", id: manifest.id, detail: differs.join(", ") });
      }
      for (const id of rows.keys()) if (!ids.has(id)) note({ code: "list_row_orphan", id });
    }
  }

  // Relationships whose target is not in this library. Imported anyway:
  // detail reads tolerate a missing target, as they do today.
  for (const { manifest } of manifests) {
    if (manifest.status !== "ready") continue;
    for (const rel of [...(manifest.connections ?? []), ...(manifest.tensions ?? [])]) {
      if (!ids.has(rel.id)) note({ code: "dangling_relationship", id: manifest.id, detail: `target ${rel.id}` });
    }
  }

  // Vectors, by composed id only.
  progress(`Fetching ${ids.size} vector id(s) from Vectorize …`);
  const composed = (id: string) => `${tenantId}:${id}`;
  const tombstoneSet = new Set(tombstones);
  const found = new Map((await deps.vectors.getByIds([...ids].sort().map(composed))).map((v) => [v.id, v]));
  const retried: string[] = [];
  const reembed: ReembedTarget[] = [];
  const invalid: string[] = [];
  const nonReady: string[] = [];
  const nonOwner: string[] = [];
  let retriedHits = 0;
  for (const { manifest } of manifests.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1))) {
    let vector = found.get(composed(manifest.id));
    if (manifest.status !== "ready") {
      if (vector) {
        nonReady.push(manifest.id);
        note({ code: "vector_for_non_ready", id: manifest.id, detail: `${manifest.status} reading; not imported` });
      }
      continue;
    }
    const entry = parsedById.get(manifest.id)!.entry;
    // Only a URL's owner is searchable: the runtime keeps no vector for a
    // duplicate (PgReadingWriter.publish), and the similarity scan does not
    // filter on ownership, so an imported duplicate vector would surface the
    // same article twice. A non-owner is neither re-embedded nor given one.
    if (!entry.owns_url) {
      if (vector) {
        nonOwner.push(manifest.id);
        note({ code: "vector_for_non_owner", id: manifest.id, detail: "the URL's owner is another reading; not imported" });
      }
      continue;
    }
    if (!vector) {
      // The founder cutover saw get_by_ids come back empty for ids a query
      // had just found, so a batch miss is asked again on its own first.
      retried.push(manifest.id);
      vector = (await deps.vectors.getByIds([composed(manifest.id)]))[0];
      if (vector) retriedHits++;
    }
    if (!vector) {
      if (manifest.tldr === undefined) continue; // blockingIssues: unusable_vector
      // A purge removed its vector on purpose, and import only ever skips a
      // tombstoned manifest, so an embedding for it would be paid for nothing.
      if (tombstoneSet.has(manifest.id)) continue;
      reembed.push({ id: manifest.id, tldr: manifest.tldr });
      note({ code: "vector_reembedded", id: manifest.id, detail: "get_by_ids did not return it; embedded from the manifest tldr" });
      continue;
    }
    // A vector under another namespace was never in this tenant's similarity
    // scan; importing it would make it searchable here for the first time.
    if (vector.namespace !== undefined && vector.namespace !== tenantId) {
      invalid.push(manifest.id);
      note({ code: "vector_namespace_mismatch", id: manifest.id, detail: `namespace ${vector.namespace}; not imported` });
      continue;
    }
    const problem = vectorProblem(vector.values);
    if (problem !== null) {
      invalid.push(manifest.id);
      note({ code: "vector_invalid", id: manifest.id, detail: problem });
      continue;
    }
    entry.embedding = { source: "vectorize", values: vector.values as number[] };
  }

  // The D1 control plane, whole: every account's rows, not only this tenant's.
  progress("Reading the D1 control plane …");
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const spec of CONTROL_PLANE_TABLES) tables[spec.table] = await deps.readD1(spec);
  // A D1 table the specs do not know (one a later D1 migration added) is
  // exported whole rather than missed, so blockingIssues refuses it as having
  // no PostgreSQL mapping: tables fail closed as columns do.
  const known = new Set([...CONTROL_PLANE_TABLES.map((spec) => spec.table), VECTOR_LEDGER_TABLE.table]);
  const catalog = await deps.readD1({ table: "sqlite_master", orderBy: "name" });
  for (const entry of catalog) {
    const name = String(entry.name);
    if (entry.type !== "table" || known.has(name) || name === "d1_migrations" || /^(_cf_|sqlite_)/.test(name)) continue;
    tables[name] = await deps.readD1({ table: name, orderBy: "rowid" });
  }
  const ledger = await deps.readD1(VECTOR_LEDGER_TABLE);
  const live = new Set(ledger.filter((r) => r.tenant_id === tenantId && r.state === "live").map((r) => String(r.reading_id)));
  for (const { manifest } of manifests) {
    if (manifest.status === "ready" && !live.has(manifest.id)) note({ code: "ledger_row_missing", id: manifest.id });
  }
  for (const id of [...live].sort()) {
    if (parsedById.get(id)?.manifest.status !== "ready") note({ code: "ledger_live_without_ready_reading", id });
  }
  const account = (tables.users ?? []).find((u) => u.id === tenantId);
  // A missing account is blocking (blockingIssues): its readings would import
  // outside every deletion path.
  if (account && account.status !== "active") {
    // The runtime keeps no vector for a tenant that is not active; the
    // embeddings still import, so the operator decides before cutover.
    note({ code: "tenant_not_active", id: tenantId, detail: `account status ${String(account.status)}` });
  }

  readings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.key_prefix < b.key_prefix ? -1 : 1));
  const library: Library = { readings, tombstones };
  const controlPlane: ControlPlaneSnapshot = { tables };
  const report = buildReport({
    tenantId,
    library,
    controlPlane,
    manifests: manifests.map((m) => m.manifest),
    discrepancies,
    duplicateOwners,
    counts: { objects: objects.length, pointers_by_url: byUrl.length, pointers_by_id: byId.size, attempts: attemptCount, processing_checkpoints: checkpointCount, raw_content_bytes: contentBytes, ledger_rows: ledger.length },
    // Every vector get_by_ids returned, batched or on the individual retry.
    vectors: { found: found.size + retriedHits, reembedded: reembed.map((r) => r.id), invalid, nonReady, nonOwner, retried },
  });
  return { library, controlPlane, report, reembed };
}

function buildReport(input: {
  tenantId: string;
  library: Library;
  controlPlane: ControlPlaneSnapshot;
  manifests: Manifest[];
  discrepancies: Discrepancy[];
  duplicateOwners: ExportReport["duplicate_url_owners"];
  counts: Record<string, number>;
  vectors: { found: number; reembedded: string[]; invalid: string[]; nonReady: string[]; nonOwner: string[]; retried: string[] };
}): ExportReport {
  const { manifests } = input;
  const byStatus = (status: string) => manifests.filter((m) => m.status === status).length;
  // A ready reading awaiting its re-embed has no vector yet, but --execute
  // gives it one before the snapshot exists (applyReembeds re-derives this),
  // so the plan does not call it blocking.
  const pendingEmbeds = new Set(input.vectors.reembedded);
  const blocking = blockingIssues(input.library, input.controlPlane, input.tenantId).filter(
    (d) => !(d.code === "unusable_vector" && d.id !== undefined && pendingEmbeds.has(d.id)),
  );
  const discrepancies = sortDiscrepancies(input.discrepancies);
  const controlPlaneTotals = Object.fromEntries(
    Object.entries(input.controlPlane.tables).map(([table, rows]) => [`control_plane.${table}`, rows.length]),
  );
  return {
    version: 1,
    tenant_id: input.tenantId,
    totals: {
      manifests: input.library.readings.length,
      parsed_manifests: manifests.length,
      ready: byStatus("ready"),
      pending: byStatus("pending"),
      failed: byStatus("failed"),
      connections: manifests.reduce((n, m) => n + (m.status === "ready" ? (m.connections?.length ?? 0) : 0), 0),
      tensions: manifests.reduce((n, m) => n + (m.status === "ready" ? (m.tensions?.length ?? 0) : 0), 0),
      tombstones: input.library.tombstones.length,
      ...input.counts,
      ...controlPlaneTotals,
    },
    discrepancy_counts: countByCode([...blocking, ...discrepancies]),
    // Over the projection PostgreSQL must return, so import can compare its
    // read-back against these directly.
    field_totals: fieldTotals(manifests.map(expectedManifest)),
    ids: manifests.map((m) => m.id).sort(),
    manifest_sha256: Object.fromEntries(
      input.library.readings.map((entry) => [entry.id, canonicalHash(entry.manifest)]),
    ),
    duplicate_url_owners: input.duplicateOwners,
    unresolved_pending: blocking
      .filter((d) => d.code === "unresolved_pending")
      .map((d) => {
        const manifest = manifests.find((m) => m.id === d.id)!;
        return { id: d.id!, status: manifest.status, active_attempt: manifest.active_attempt?.id ?? null };
      }),
    tombstones: input.library.tombstones,
    vectors: {
      found: input.vectors.found,
      reembedded: input.vectors.reembedded,
      invalid: input.vectors.invalid,
      non_ready: input.vectors.nonReady,
      non_owner: input.vectors.nonOwner,
      retried_individually: input.vectors.retried,
    },
    blocking,
    discrepancies,
  };
}

/**
 * Puts the re-embedded vectors into the collection and re-derives the report
 * (a ready reading that had no vector is no longer unusable once it has one).
 */
export function applyReembeds(collection: ExportCollection, embeddings: readonly number[][]): ExportCollection {
  if (embeddings.length !== collection.reembed.length) {
    throw new Error(`embedding response count mismatch: got ${embeddings.length}, expected ${collection.reembed.length}`);
  }
  const byId = new Map(collection.reembed.map((target, i) => [target.id, embeddings[i]!]));
  for (const [id, values] of byId) {
    const problem = vectorProblem(values);
    if (problem !== null) throw new Error(`re-embedded vector for ${id} is unusable: ${problem}`);
  }
  const readings = collection.library.readings.map((entry) =>
    byId.has(entry.id) && entry.embedding === null
      ? { ...entry, embedding: { source: "reembedded" as const, values: byId.get(entry.id)! } }
      : entry,
  );
  const library = { ...collection.library, readings };
  return {
    ...collection,
    library,
    report: {
      ...collection.report,
      blocking: blockingIssues(library, collection.controlPlane, collection.report.tenant_id),
      discrepancy_counts: countByCode([
        ...blockingIssues(library, collection.controlPlane, collection.report.tenant_id),
        ...collection.report.discrepancies,
      ]),
    },
  };
}
