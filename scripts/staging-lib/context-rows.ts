// Database observations for the context planner. Source/destination each get
// a read-only repeatable snapshot, never a cross-database transaction. Their
// fingerprints and absence checks must be revalidated at application time.
import type { Sql } from "../../src/modules/db/sql";
import { parseTenantId } from "../../src/control-plane/ids";
import { operatorReadings } from "../pg-lib/operator-corpus";
import {
  withOperatorSql,
  resolveOperatorDatabaseUrl,
  type OpenOperatorSql,
} from "../pg-lib/operator-db";
import { SourceContextSchema, type SourceContext } from "./context-copy";

export async function withContextDatabases<T>(
  env: Record<string, string | undefined>,
  work: (source: Sql, destination: Sql) => Promise<T>,
  open?: OpenOperatorSql,
): Promise<T> {
  // Resolve both before opening either: a missing staging variable cannot
  // strand a source connection. Nested ownership also closes on partial open.
  const source = resolveOperatorDatabaseUrl({
    bucket: "reading-lite",
    env,
  }).url;
  const destination = resolveOperatorDatabaseUrl({
    bucket: "reading-lite-staging",
    env,
  }).url;
  return withOperatorSql(
    source,
    (sourceSql) =>
      withOperatorSql(
        destination,
        (destinationSql) => work(sourceSql, destinationSql),
        open,
      ),
    open,
  );
}

export async function readContextRows(
  source: Sql,
  destination: Sql,
  sourceTenant: string,
  destinationTenant: string,
  ids: string[],
  seedIds: string[],
): Promise<SourceContext[]> {
  const from = parseTenantId(sourceTenant),
    to = parseTenantId(destinationTenant);
  if (!from || !to || from === to)
    throw Error("Distinct canonical tenants required");
  const entries = await source.transaction(
    async (tx) => {
      const store = operatorReadings(tx, { tenantId: from });
      const entries: SourceContext[] = [];
      // One SQL client: keep its observations sequential, including store calls.
      for (const id of ids) {
        const reading = await store.loadReadingById(id);
        if (!reading) throw Error("Missing source reading " + id);
        const owner = await store.findOwnerByUrl(reading.manifest.url);
        const contentKeys = await store.contentKeys(id);
        const [row] = await tx.query<{ current_revision_id: string | null }>(
          "SELECT current_revision_id FROM readings WHERE tenant_id = $1 AND id = $2",
          [from, id],
        );
        let embedding: unknown = null;
        if (seedIds.includes(id)) {
          const [vector] = await tx.query<{ embedding: string }>(
            "SELECT embedding::text AS embedding FROM reading_embeddings WHERE tenant_id = $1 AND reading_id = $2",
            [from, id],
          );
          if (vector) embedding = JSON.parse(vector.embedding);
        }
        entries.push(
          SourceContextSchema.parse({
            keyPrefix: reading.keyPrefix,
            manifest: reading.manifest,
            ownerId: owner?.id ?? null,
            revisionId: row?.current_revision_id ?? null,
            contentKeys,
            embedding,
          }),
        );
      }
      return entries;
    },
    { readOnly: true, repeatableRead: true },
  );

  await destination.transaction(
    async (tx) => {
      const [state] = await tx.query(
        "SELECT u.status, sp.paid_work_enabled FROM users u CROSS JOIN system_policy sp WHERE u.id = $1 AND sp.id = 1",
        [to],
      );
      if (state?.status !== "active" || state.paid_work_enabled !== false)
        throw Error("Staging tenant must be active and paid work disabled");
      const store = operatorReadings(tx, { tenantId: to });
      const urls = entries.map((entry) => entry.manifest.url);
      const occupants = await store.allListItems();
      if (occupants.some((row) => ids.includes(row.id)))
        throw Error("Occupied destination reading ID");
      if (occupants.some((row) => urls.includes(row.url)))
        throw Error("Occupied destination reading URL");
      if (
        occupants.some((row) =>
          entries.some(
            (entry) =>
              row.key_prefix === entry.keyPrefix ||
              row.key_prefix.startsWith(entry.keyPrefix + "/") ||
              entry.keyPrefix.startsWith(row.key_prefix + "/"),
          ),
        )
      )
        throw Error("Occupied destination reading prefix");
      // Also catch a corrupt hash owner that findOwnerByUrl cannot validate by
      // URL string: that slot would still prevent the packet's ownership insert.
      const claims = await tx.query(
        "SELECT reading_id FROM reading_urls WHERE tenant_id = $1 AND url_hash = ANY ($2::text[])",
        [to, entries.map((entry) => entry.manifest.url_hash)],
      );
      if (claims.length) throw Error("Occupied destination URL ownership");
    },
    { readOnly: true, repeatableRead: true },
  );
  return entries;
}
