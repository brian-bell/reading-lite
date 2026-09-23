// Offline batch storage: runtime read/write stores own all reading state.
// R2 holds only captured bytes; every read and transaction is tenant scoped.
import { sqlSession, type Sql } from "../../../src/modules/db/sql";
import { openOperatorSql, withOperatorSql } from "../../pg-lib/operator-db";
import type { TenantContext } from "../../../src/control-plane/ids";
import type { Manifest, ManifestStatus } from "../../../src/schemas/manifest";
import { compareUrlOwnership } from "../../../src/modules/stores/list-items";
import { pgReadingStoreFor } from "../../../src/modules/stores/postgres/reading-store";
import {
  pgReadingWriterFor,
  type AttemptContentKeys,
} from "../../../src/modules/stores/postgres/reading-writer";
import { pgSimilarityStoreFor } from "../../../src/modules/stores/postgres/similarity-store";
import { discardUnreferencedContent } from "../../../src/attempt-io";
import type { BatchTarget, SidecarTarget } from "./types";
import type { FreshMarkdownDeps } from "./prepare-fresh-markdown";
import type { SimilarDeps } from "./similar-phase";

export interface BatchCorpus
  extends Pick<
    FreshMarkdownDeps,
    "getByUrl" | "readManifest" | "findReadingByUrl"
  > {
  contentKeys(keyPrefix: string): Promise<AttemptContentKeys | null>;
  query: SimilarDeps["query"];
  discardContent(
    target: Pick<BatchTarget, "readingId" | "keyPrefix" | "attemptId">,
    keys: AttemptContentKeys,
    remove: (key: string) => Promise<void>,
  ): Promise<void>;
  activate(
    pending: Manifest,
    keyPrefix: string,
    content: AttemptContentKeys,
    seen: Manifest | null,
  ): Promise<boolean>;
  disposition(target: SidecarTarget): Promise<"active" | "complete" | "stale">;
  publish(
    target: SidecarTarget,
    ready: Manifest,
    embedding: number[],
  ): Promise<boolean>;
  fail(target: SidecarTarget, failed: Manifest): Promise<boolean>;
}

export function batchCorpusFor(sql: Sql, tenant: TenantContext): BatchCorpus {
  const store = pgReadingStoreFor(sql, tenant);
  const writer = pgReadingWriterFor(sql, tenant);
  const similarity = pgSimilarityStoreFor(sql, tenant);
  const byPrefix = async (keyPrefix: string) => {
    const [row] = await sql.query<{ id: string }>(
      "SELECT id FROM readings WHERE tenant_id = $1 AND key_prefix = $2",
      [tenant.tenantId, keyPrefix],
    );
    return row ? store.loadReadingById(row.id) : null;
  };
  return {
    async getByUrl(hash) {
      const [row] = await sql.query<{ id: string; key_prefix: string }>(
        "SELECT r.id, r.key_prefix FROM reading_urls u JOIN readings r ON r.tenant_id = u.tenant_id AND r.id = u.reading_id WHERE u.tenant_id = $1 AND u.url_hash = $2",
        [tenant.tenantId, hash],
      );
      return row ?? null;
    },
    readManifest: async (prefix) => (await byPrefix(prefix))?.manifest ?? null,
    // A reading for this URL that holds no URL claim (one whose claim was
    // released before releases were retired). Reuse its reading on retry,
    // ranked by the one URL-ownership rule the list and the importer share.
    async findReadingByUrl(url, hash) {
      const rows = await sql.query<{ id: string; status: ManifestStatus; created_at: string; updated_at: string }>(
        "SELECT id, status, created_at, updated_at FROM readings WHERE tenant_id = $1 AND url = $2 AND url_hash = $3",
        [tenant.tenantId, url, hash],
      );
      const [row] = rows.sort((a, b) => compareUrlOwnership(a, b) || a.id.localeCompare(b.id));
      const found = row ? await store.loadReadingById(row.id) : null;
      return found
        ? {
            id: found.manifest.id,
            key_prefix: found.keyPrefix,
            manifest: found.manifest,
          }
        : null;
    },
    async contentKeys(prefix) {
      const found = await byPrefix(prefix);
      return found ? store.contentKeys(found.manifest.id) : null;
    },
    async query(vector, opts) {
      return (await similarity.query(vector, opts.topK)).map((m) => ({
        id: m.id,
        score: m.score,
        metadata: { url: m.url, title: m.title, tldr: m.tldr },
      }));
    },
    async discardContent(target, keys, remove) {
      await discardUnreferencedContent(
        store,
        {
          async deletePrefix(prefix) {
            let deleted = 0;
            for (const key of [keys.rawKey, keys.extractedKey]) {
              if (key && key.startsWith(prefix)) {
                await remove(key);
                deleted++;
              }
            }
            return deleted;
          },
        },
        {
          id: target.readingId,
          keyPrefix: target.keyPrefix,
          attemptId: target.attemptId,
        },
      );
    },
    async activate(pending, prefix, content, seen) {
      const attempt = {
        summary: pending.active_attempt!,
        payload: null,
        offline: true,
        content,
      };
      if (!seen)
        return (
          (await writer.claimUrl(pending, prefix, attempt)).kind === "claimed"
        );
      return (
        (await writer.startAttempt(pending, attempt, seen)).kind === "started"
      );
    },
    async disposition(target) {
      const found = await store.loadReadingById(target.id);
      if (
        !found ||
        found.keyPrefix !== target.keyPrefix ||
        found.manifest.url_hash !== target.urlHash ||
        found.manifest.url !== target.url
      )
        return "stale";
      const m = found.manifest;
      if (target.attemptId) {
        if (m.active_attempt?.id === target.attemptId) return "active";
        if (!m.active_attempt && m.last_attempt?.id === target.attemptId)
          return "complete";
        return "stale";
      }
      // Legacy sidecars have no attempt identity. Only a vacant pending row is
      // eligible; never adopt a newer attempt or recreate a missing reading.
      return m.status === "pending" && !m.active_attempt && !m.last_attempt
        ? "active"
        : "stale";
    },
    async publish(target, ready, embedding) {
      const [attempt] = target.attemptId
        ? await sql.query<{
            raw_key: string | null;
            extracted_key: string | null;
          }>(
            "SELECT raw_key, extracted_key FROM reading_attempts WHERE tenant_id = $1 AND reading_id = $2 AND id = $3",
            [tenant.tenantId, target.id, target.attemptId],
          )
        : [];
      const content = attempt?.raw_key
        ? { rawKey: attempt.raw_key, extractedKey: attempt.extracted_key }
        : await store.contentKeys(target.id);
      if (!content) {
        // Purge may win while terminal embedding is in flight. The missing
        // row is the deletion fence, not corrupt content that needs a retry.
        if (!(await store.loadReadingById(target.id))) return false;
        throw new Error(`batch content keys missing for ${target.id}`);
      }
      return (
        await writer.publish(target, ready, {
          keyPrefix: target.keyPrefix,
          content,
          embedding,
          claimMissingUrl: true,
        })
      ).committed;
    },
    async fail(target, failed) {
      return (
        await writer.fail(target, failed, {
          allowLastAttempt: false,
          now: failed.updated_at,
        })
      ).committed;
    },
  };
}

// Provider polling can last hours. Renew an idle direct connection before the
// next database operation, retaining the operator seam's guaranteed close.
export function withBatchCorpus<T>(
  url: string,
  tenant: TenantContext,
  work: (corpus: BatchCorpus) => Promise<T>,
): Promise<T> {
  return withOperatorSql(
    url,
    (sql) => work(batchCorpusFor(sql, tenant)),
    (connection) => sqlSession(() => openOperatorSql(connection)),
  );
}
