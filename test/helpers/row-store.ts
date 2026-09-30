import type { TenantContext } from "../../src/control-plane/ids";
import type { ListIndexItem } from "../../src/schemas/api";
import type { Manifest, ProcessingAttempt } from "../../src/schemas/manifest";
import { founderTenant } from "./tenant-fixtures";
import { testReadingsFor, type TestReadings } from "./test-readings";

// Reading state is PostgreSQL rows now (ADR 0005). Many integration tests arrange a
// reading the way the old storage spelled it: a manifest at a key prefix, the
// by-url and by-id pointers, a list row. `rowStore` keeps those verbs so each
// test still reads as the scenario it describes, and maps them onto rows:
//
// - writeManifest seeds the reading; its rows are the list row and the by-id
//   pointer, so there is no separate write for either;
// - writeByUrlPointer makes that reading the URL's owner, which is all a by-url
//   pointer ever meant. One that names a reading not seeded yet is applied when
//   the reading arrives;
// - the reads project rows back into the old shapes.
//
// Assertions about the pointer objects themselves went with the pointers.
const idOfPrefix = (keyPrefix: string) => keyPrefix.slice(keyPrefix.lastIndexOf("-") + 1);

export function rowStore(tenant: TenantContext = founderTenant()) {
  const readings: TestReadings = testReadingsFor(tenant);
  const tenantId = String(tenant.tenantId);
  const pendingOwners = new Map<string, string>();
  const own = async (urlHash: string, readingId: string) => {
    const [exists] = await readings.sql.query("SELECT 1 FROM readings WHERE tenant_id = $1 AND id = $2", [tenantId, readingId]);
    if (!exists) {
      pendingOwners.set(urlHash, readingId);
      return;
    }
    await readings.sql.query(
      `INSERT INTO reading_urls (tenant_id, url_hash, reading_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, url_hash) DO UPDATE SET reading_id = EXCLUDED.reading_id`,
      [tenantId, urlHash, readingId],
    );
  };
  return {
    readings,
    async writeManifest(keyPrefix: string, manifest: Manifest): Promise<void> {
      await readings.seed(manifest, { keyPrefix });
      const owner = pendingOwners.get(manifest.url_hash);
      if (owner === manifest.id) {
        pendingOwners.delete(manifest.url_hash);
        await own(manifest.url_hash, owner);
      }
    },
    readManifest: (keyPrefix: string) => readings.manifest(idOfPrefix(keyPrefix)),
    loadReadingById: (readingId: string) => readings.store.loadReadingById(readingId),
    // The key prefix a pointer carried is the reading's own; only the id matters.
    writeByUrlPointer: (urlHash: string, pointer: { id: string; key_prefix?: string }) => own(urlHash, pointer.id),
    async readByUrlPointer(urlHash: string): Promise<{ id: string; key_prefix: string } | null> {
      const [row] = await readings.sql.query<{ id: string; key_prefix: string }>(
        `SELECT r.id, r.key_prefix FROM reading_urls u
         JOIN readings r ON (r.tenant_id, r.id) = (u.tenant_id, u.reading_id)
         WHERE u.tenant_id = $1 AND u.url_hash = $2`,
        [tenantId, urlHash],
      );
      return row ?? null;
    },
    async readByIdPointer(readingId: string): Promise<{ id: string; key_prefix: string } | null> {
      const keyPrefix = await readings.keyPrefix(readingId);
      return keyPrefix === null ? null : { id: readingId, key_prefix: keyPrefix };
    },
    writeListIndex: (index: { version?: 1; items: ListIndexItem[] }) => readings.seedListItems(index.items),
    async readListIndex(): Promise<{ version: 1; items: ListIndexItem[] }> {
      return { version: 1, items: await readings.store.allListItems() };
    },
    // Through the row's keys: a published reading's bytes are under its
    // revision, a seeded one's at the legacy spelling.
    async readExtracted(keyPrefix: string) {
      const keys = await readings.store.contentKeys(idOfPrefix(keyPrefix));
      return keys?.extractedKey ? readings.content.get(keys.extractedKey) : null;
    },
    async readRaw(keyPrefix: string, _ext?: string) {
      const keys = await readings.store.contentKeys(idOfPrefix(keyPrefix));
      return keys ? readings.content.get(keys.rawKey) : null;
    },
    findListIndexItem: async (readingId: string): Promise<ListIndexItem | null> =>
      (await readings.store.relationshipTargets([readingId]))[0] ?? null,
    // The attempt log is rows; the key prefix only names the reading.
    listAttempts: (keyPrefix: string, limit = 20) => readings.writer.listAttempts(idOfPrefix(keyPrefix), limit),
    writeAttempt: (_keyPrefix: string, attempt: ProcessingAttempt) => readings.writer.recordAttempt(attempt),
    listReadingObjects: (keyPrefix: string) => readings.content.list(keyPrefix),
    // A purge used to leave a tombstone for late consumers to find. It deletes
    // the reading's rows now, and the missing row is what they find.
    writePurgeTombstone: (readingId: string) => readings.purge(readingId),
    writeExtracted: (keyPrefix: string, markdown: string) =>
      readings.content.put(`${keyPrefix}/extracted.md`, markdown, "text/markdown; charset=utf-8"),
    writeRaw: (keyPrefix: string, ext: string, bytes: Uint8Array, contentType: string) =>
      readings.content.put(`${keyPrefix}/raw.${ext}`, bytes, contentType),
  };
}
