import type { Context } from "hono";
import {
  ArchiveExportActiveErrorSchema,
  ArchiveExportDailyLimitSchema,
  ArchiveExportExpiredSchema,
  ArchiveExportNotReadySchema,
  GetArchiveExportLatestResponseSchema,
  PostArchiveExportResponseSchema,
} from "../schemas/api";
import type { AppBindings } from "../middleware";
import { contentStoreFor, type ContentStore } from "../modules/stores/content-store";
import {
  latestArchiveExport,
  markArchiveExportFailed,
  ownedArchiveDownload,
  requestArchiveExport,
} from "./archive-exports";
import { fromSql } from "./db";
import { archiveExportEnvelopeV1 } from "./export-envelope";

const ARCHIVE_FILENAME = "reading-lite-archive.zip";

export async function handlePostArchiveExport(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const queue = c.env.ARCHIVE_EXPORT_JOBS;
  if (!queue) return c.json({ error: "export queue unavailable" }, 503);

  const principal = c.get("principal");
  const db = fromSql(c.get("sql"));
  const result = await requestArchiveExport(db, { userId: principal.userId, nowMs });
  if (result.kind === "inactive") return c.json({ error: "forbidden" }, 403);
  if (result.kind === "active") {
    return c.json(ArchiveExportActiveErrorSchema.parse({ error: "export_active", id: result.id }), 409);
  }
  if (result.kind === "daily") {
    return c.json(
      ArchiveExportDailyLimitSchema.parse({
        limit: "daily_export",
        reset_at: new Date(result.resetAtMs).toISOString(),
      }),
      429,
    );
  }

  try {
    await queue.send(archiveExportEnvelopeV1({ tenantId: principal.tenantId, exportId: result.id }));
  } catch (error) {
    console.error(error);
    await markArchiveExportFailed(db, {
      tenantId: principal.tenantId,
      exportId: result.id,
      nowMs,
      error: { code: "enqueue_failed" },
    });
    return c.json({ error: "export queue unavailable" }, 503);
  }
  return c.json(PostArchiveExportResponseSchema.parse({ id: result.id, status: "queued" }), 202);
}

export async function handleGetLatestArchiveExport(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const latest = await latestArchiveExport(fromSql(c.get("sql")), { userId: principal.userId, nowMs });
  return c.json(
    GetArchiveExportLatestResponseSchema.parse({
      export: latest.export,
      next_allowed_at: new Date(latest.nextAllowedAtMs).toISOString(),
    }),
  );
}

export async function handleDownloadArchiveExport(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const principal = c.get("principal");
  const owned = await ownedArchiveDownload(fromSql(c.get("sql")), {
    userId: principal.userId,
    exportId: c.req.param("id") ?? "",
    nowMs,
  });
  if (owned.kind === "not_found") return c.json({ error: "not found" }, 404);
  if (owned.kind === "not_ready") return c.json(ArchiveExportNotReadySchema.parse({ error: "not_ready" }), 409);
  if (owned.kind === "expired") return c.json(ArchiveExportExpiredSchema.parse({ error: "expired" }), 410);

  const content = contentStoreFor(c.env.READINGS_BUCKET, { tenantId: principal.tenantId }, c.env);
  // Sizes first, bodies later: a Worker keeps only six connections open, so
  // opening every part before streaming stalls an archive with more parts.
  for (const part of owned.segments.parts) {
    const size = await content.size(part.key);
    if (size !== part.bytes) return c.json({ error: "internal" }, 500);
  }
  return archiveDownloadResponse(content, owned.segments.parts, owned.segments.total_bytes);
}

// Opens one part at a time as the client reads, so the download holds one
// chunk, not the archive.
function archiveDownloadResponse(
  content: ContentStore,
  parts: ReadonlyArray<{ key: string; bytes: number }>,
  totalBytes: number,
): Response {
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          const part = parts[next++];
          if (!part) {
            controller.close();
            return;
          }
          const object = await content.get(part.key);
          if (!object?.body || object.size !== part.bytes) throw new Error(`archive part changed: ${part.key}`);
          reader = (object.body as ReadableStream<Uint8Array>).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        if (value && value.byteLength > 0) {
          controller.enqueue(value);
          return;
        }
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(totalBytes),
      "content-disposition": `attachment; filename="${ARCHIVE_FILENAME}"`,
      "cache-control": "no-store",
    },
  });
}
