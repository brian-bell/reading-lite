// Workers-pool helpers for the PostgreSQL store tests. Every test mints its
// own tenant id, so parallel files never collide on the one shared database.
import { env } from "cloudflare:test";
import { manifestToRows, writeReadingRows, type ManifestRowsInput } from "../../scripts/pg-lib/manifest-rows";
import { mintUserId, parseTenantId, type TenantContext } from "../../src/control-plane/ids";
import { sqlFor, type Sql } from "../../src/modules/db/sql";
import { buildKeyPrefix } from "../../src/modules/stores/layout";
import { EMBEDDING_DIM } from "../../src/schemas/api";
import { ManifestSchema, type Manifest } from "../../src/schemas/manifest";
import { sha256Hex } from "../../src/services";

export function mintTenant(): TenantContext {
  return { tenantId: parseTenantId(mintUserId())! };
}

export function testSql(): Sql {
  return sqlFor(env);
}

export async function readyManifest(id: string, overrides: Partial<Manifest> = {}): Promise<Manifest> {
  const url = overrides.url ?? `https://example.com/${id}`;
  return ManifestSchema.parse({
    id,
    url,
    url_hash: await sha256Hex(url),
    source_type: "url",
    status: "ready",
    title: `Title ${id}`,
    tldr: `Tldr ${id}`,
    tags: ["alpha"],
    keywords: ["one", "two", "three"],
    people: [],
    orgs: [],
    connections: [],
    summary_markdown: "## Summary",
    content_type: "text/html; charset=utf-8",
    content_status: "captured",
    content_bytes: 10,
    extracted_bytes: 5,
    content_sha256: "0".repeat(64),
    created_at: "2026-04-26T20:00:00.000Z",
    updated_at: "2026-04-26T20:00:00.000Z",
    ...overrides,
  });
}

export async function seedManifest(
  sql: Sql,
  tenant: TenantContext,
  manifest: Manifest,
  input: Partial<Omit<ManifestRowsInput, "tenantId">> = {},
): Promise<string> {
  const keyPrefix = input.keyPrefix ?? buildKeyPrefix(manifest.id, manifest.created_at);
  const rows = manifestToRows(manifest, {
    tenantId: String(tenant.tenantId),
    keyPrefix,
    ownsUrl: input.ownsUrl ?? true,
    embedding: input.embedding,
  });
  await sql.transaction((tx) => writeReadingRows(tx, rows));
  return keyPrefix;
}

// A unit vector along one axis, nudged toward axis 0 by `lean`, so tests can
// order neighbours by construction.
export function axisVector(axis: number, lean = 0): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  vector[axis] = 1;
  if (axis !== 0) vector[0] = lean;
  return vector;
}
