import { Hono } from "hono";
import type { Env } from "./index";
import { corsMiddleware, requireBearer } from "./middleware";
import {
  newAttemptId,
  newAttemptSummary,
  newReadingArgs,
  type ProcessReadingArgs,
  type ProcessReadingSource,
} from "./process-reading";
import {
  ListReadingsQuerySchema,
  PostReadingReprocessBodySchema,
  PostReadingsBodySchema,
  PostReadingsImportMarkdownBodySchema,
  PostReadingsSimilarBodySchema,
} from "./schemas/api";
import type { Manifest, ProcessingAttemptSummary } from "./schemas/manifest";
import {
  manifestToIndexItem,
  ReadingStore,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
import { defaultServices, sha256Hex, type Services } from "./services";

export interface AppOptions {
  services?: Services;
}

export function createApp(opts: AppOptions = {}) {
  const services = opts.services ?? defaultServices();
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", corsMiddleware());

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  app.get("/health", (c) => c.text("ok", 200));

  // Everything below requires bearer auth.
  app.use("/readings", requireBearer());
  app.use("/readings/*", requireBearer());

  app.post("/readings", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const url = parsed.data.url;

    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const urlHash = await sha256Hex(url);
    const existing = await reader.readByUrlPointer(urlHash);
    if (existing) {
      const m = await reader.readManifest(existing.key_prefix);
      if (m) return c.json(m, 200);
    }

    const args = await newReadingArgs(url, services);
    const attemptStartedAt = services.now();
    const attemptId = newAttemptId(services);
    const activeAttempt = newAttemptSummary(attemptId, "submit", attemptStartedAt);
    const pendingManifest: Manifest = {
      id: args.id,
      url,
      url_hash: args.urlHash,
      source_type: "url",
      status: "pending",
      active_attempt: activeAttempt,
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: args.createdAt,
      updated_at: args.createdAt,
    };
    if (!c.env.READING_JOBS) {
      return c.json(
        { error: "queue binding READING_JOBS is not configured" },
        503,
      );
    }

    await reader.writeManifest(args.keyPrefix, pendingManifest);
    await reader.writeByIdPointer(args.id, { id: args.id, key_prefix: args.keyPrefix });
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(pendingManifest, args.keyPrefix),
    );

    await c.env.READING_JOBS.send({
      ...args,
      attemptId,
      attemptStartedAt,
      trigger: "submit",
      email: parsed.data.email ?? true,
    });

    return c.json(
      { id: args.id, status: "pending", poll: `/readings/${args.id}`, attempt_id: attemptId },
      202,
    );
  });

  app.post("/readings/import-markdown", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsImportMarkdownBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }

    const url = parsed.data.source_url;
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const urlHash = await sha256Hex(url);
    const existing = await reader.readByUrlPointer(urlHash);
    if (existing) {
      const m = await reader.readManifest(existing.key_prefix);
      if (m) return c.json(m, 200);
    }

    const source: ProcessReadingSource = {
      kind: "markdown",
      markdown: parsed.data.markdown,
      ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
    };
    const args = await newReadingArgs(url, services, source);
    const attemptStartedAt = services.now();
    const attemptId = newAttemptId(services);
    const activeAttempt = newAttemptSummary(attemptId, "import", attemptStartedAt);
    const pendingManifest: Manifest = {
      id: args.id,
      url,
      url_hash: args.urlHash,
      source_type: "markdown",
      status: "pending",
      active_attempt: activeAttempt,
      ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
      content_type: "text/markdown; charset=utf-8",
      content_status: "captured",
      content_bytes: new TextEncoder().encode(parsed.data.markdown).byteLength,
      content_sha256: await sha256Hex(parsed.data.markdown),
      created_at: args.createdAt,
      updated_at: args.createdAt,
    };
    if (!c.env.READING_JOBS) {
      return c.json(
        { error: "queue binding READING_JOBS is not configured" },
        503,
      );
    }

    await reader.writeManifest(args.keyPrefix, pendingManifest);
    await reader.writeByIdPointer(args.id, { id: args.id, key_prefix: args.keyPrefix });
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(pendingManifest, args.keyPrefix),
    );

    await c.env.READING_JOBS.send({
      ...args,
      attemptId,
      attemptStartedAt,
      trigger: "import",
      email: parsed.data.email ?? false,
    });

    return c.json(
      { id: args.id, status: "pending", poll: `/readings/${args.id}`, attempt_id: attemptId },
      202,
    );
  });

  app.get("/readings", async (c) => {
    const parsed = ListReadingsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid query", details: parsed.error.message }, 400);
    }
    const { q, tag, offset, limit } = parsed.data;
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const out = await reader.listManifests({ q, tag, offset, limit });
    const annotated = out.readings.map((item) => annotateStaleIndexItem(item, c.env, services));
    return c.json({
      readings: annotated,
      limit,
      offset,
      has_more: offset + annotated.length < out.total_filtered,
    });
  });

  app.get("/readings/lookup", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "missing url" }, 400);
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const hash = await sha256Hex(url);
    const ptr = await reader.readByUrlPointer(hash);
    if (!ptr) return c.json({ error: "not found" }, 404);
    return c.json({ id: ptr.id });
  });

  app.post("/readings/similar", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsSimilarBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const similarity = new SimilarityStore(c.env.READINGS_INDEX);
    const items = await similarity.query(parsed.data.query_embedding, parsed.data.k);
    return c.json({ items });
  });

  app.get("/readings/:id/diagnostics", async (c) => {
    const id = c.req.param("id");
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const ptr = await reader.readByIdPointer(id);
    if (!ptr) return c.json({ error: "not found" }, 404);
    const manifest = await reader.readManifest(ptr.key_prefix);
    if (!manifest) return c.json({ error: "not found" }, 404);
    const byUrl = await reader.readByUrlPointer(manifest.url_hash);
    const indexItem = await reader.findListIndexItem(id);
    const objects = await reader.listReadingObjects(ptr.key_prefix);
    const attempts = await reader.listAttempts(ptr.key_prefix, 20);
    return c.json({
      id,
      key_prefix: ptr.key_prefix,
      manifest: annotateStale(manifest, c.env, services),
      index_item: indexItem ? annotateStaleIndexItem(indexItem, c.env, services) : null,
      pointers: {
        by_id: {
          exists: true,
          pointer: ptr,
          matches_manifest: ptr.id === id && manifest.id === id,
        },
        by_url: {
          exists: byUrl !== null,
          ...(byUrl ? { pointer: byUrl } : {}),
          matches_manifest: byUrl?.id === manifest.id && byUrl.key_prefix === ptr.key_prefix,
        },
      },
      objects,
      attempts,
    });
  });

  app.post("/readings/:id/reprocess", async (c) => {
    let json: unknown;
    try {
      const text = await c.req.text();
      json = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const parsed = PostReadingReprocessBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }

    const id = c.req.param("id");
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const ptr = await reader.readByIdPointer(id);
    if (!ptr) return c.json({ error: "not found" }, 404);
    const manifest = await reader.readManifest(ptr.key_prefix);
    if (!manifest) return c.json({ error: "not found" }, 404);
    const effectiveManifest = annotateStale(manifest, c.env, services);
    if (effectiveManifest.active_attempt?.status === "running" && !parsed.data.force) {
      return c.json({ error: "reading already has an active attempt" }, 409);
    }
    if (!c.env.READING_JOBS) {
      return c.json(
        { error: "queue binding READING_JOBS is not configured" },
        503,
      );
    }

    const attemptStartedAt = services.now();
    const attemptId = newAttemptId(services);
    const activeAttempt = newAttemptSummary(attemptId, "reprocess", attemptStartedAt);
    let source: ProcessReadingSource | undefined;
    if (effectiveManifest.source_type === "markdown") {
      const extracted = await reader.readExtracted(ptr.key_prefix);
      if (!extracted) {
        return c.json({ error: "markdown content not available" }, 409);
      }
      source = {
        kind: "markdown",
        markdown: await extracted.text(),
        ...(effectiveManifest.title === undefined ? {} : { title: effectiveManifest.title }),
      };
    }
    const args: ProcessReadingArgs = {
      id: effectiveManifest.id,
      url: effectiveManifest.url,
      urlHash: effectiveManifest.url_hash,
      createdAt: effectiveManifest.created_at,
      keyPrefix: ptr.key_prefix,
      source,
      attemptId,
      attemptStartedAt,
      trigger: "reprocess",
      preserveReadyManifest: effectiveManifest.status === "ready" ? effectiveManifest : undefined,
      email: parsed.data.email ?? false,
    };
    const nextManifest = manifestForActiveAttempt(effectiveManifest, activeAttempt, services);

    await reader.writeManifest(ptr.key_prefix, nextManifest);
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(nextManifest, ptr.key_prefix),
    );

    await c.env.READING_JOBS.send(args);

    return c.json(
      { id: effectiveManifest.id, status: nextManifest.status, poll: `/readings/${effectiveManifest.id}`, attempt_id: attemptId },
      202,
    );
  });

  app.get("/readings/:id", async (c) => {
    const id = c.req.param("id");
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const ptr = await reader.readByIdPointer(id);
    if (!ptr) return c.json({ error: "not found" }, 404);
    const manifest = await reader.readManifest(ptr.key_prefix);
    if (!manifest) return c.json({ error: "not found" }, 404);
    return c.json(annotateStale(manifest, c.env, services));
  });

  app.get("/readings/:id/content", async (c) => {
    const id = c.req.param("id");
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const ptr = await reader.readByIdPointer(id);
    if (!ptr) return c.json({ error: "not found" }, 404);
    const manifest = await reader.readManifest(ptr.key_prefix);
    if (!manifest) return c.json({ error: "not found" }, 404);
    if (manifest.content_status !== "captured") {
      return c.json({ error: "extracted markdown not available" }, 404);
    }
    const obj = await reader.readExtracted(ptr.key_prefix);
    if (!obj || !obj.body) return c.json({ error: "not found" }, 404);
    return new Response(obj.body, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  });

  app.get("/readings/:id/content/raw", async (c) => {
    const id = c.req.param("id");
    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const ptr = await reader.readByIdPointer(id);
    if (!ptr) return c.json({ error: "not found" }, 404);
    const manifest = await reader.readManifest(ptr.key_prefix);
    if (!manifest) return c.json({ error: "not found" }, 404);
    const ext = extFromContentType(manifest.content_type);
    const obj = await reader.readRaw(ptr.key_prefix, ext);
    if (!obj || !obj.body) return c.json({ error: "not found" }, 404);
    return new Response(obj.body, {
      status: 200,
      headers: { "content-type": obj.contentType },
    });
  });

  return app;
}

function manifestForActiveAttempt(
  manifest: Manifest,
  activeAttempt: ProcessingAttemptSummary,
  services: Services,
): Manifest {
  if (manifest.status === "ready") {
    return {
      ...manifest,
      active_attempt: activeAttempt,
      updated_at: services.now(),
    };
  }

  return {
    id: manifest.id,
    url: manifest.url,
    url_hash: manifest.url_hash,
    source_type: manifest.source_type,
    status: "pending",
    active_attempt: activeAttempt,
    last_attempt: manifest.last_attempt,
    title: manifest.title,
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: manifest.created_at,
    updated_at: services.now(),
  };
}

function extFromContentType(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}

function annotateStale(manifest: Manifest, env: Env, services: Services): Manifest {
  const activeExpired = expiredActiveAttempt(manifest.active_attempt, env, services);
  if (activeExpired) {
    const next: Manifest = {
      ...manifest,
      active_attempt: undefined,
      last_attempt: activeExpired,
      updated_at: activeExpired.finished_at ?? services.now(),
    };
    if (manifest.status === "pending") {
      return {
        ...next,
        status: "failed",
        error: activeExpired.error,
      };
    }
    return next;
  }

  if (manifest.status !== "pending") return manifest;
  const ttl = pendingTtlSeconds(env);
  const updatedAt = Date.parse(manifest.updated_at);
  const now = Date.parse(services.now());
  if (Number.isFinite(updatedAt) && now - updatedAt > ttl * 1000) {
    return { ...manifest, status: "failed", error: { code: "stale_pending", message: `pending > ${ttl}s` } };
  }
  return manifest;
}

function annotateStaleIndexItem(
  item: import("./schemas/api").ListIndexItem,
  env: Env,
  services: Services,
): import("./schemas/api").ListIndexItem {
  const activeExpired = expiredActiveAttempt(item.active_attempt, env, services);
  if (activeExpired) {
    const next: import("./schemas/api").ListIndexItem = {
      ...item,
      active_attempt: undefined,
      last_attempt: activeExpired,
      updated_at: activeExpired.finished_at ?? services.now(),
    };
    if (item.status === "pending") {
      return {
        ...next,
        status: "failed",
        error: activeExpired.error,
      };
    }
    return next;
  }

  if (item.status !== "pending") return item;
  const ttl = pendingTtlSeconds(env);
  // Prefer updated_at — same semantics as the manifest-level annotateStale.
  // Older index entries (pre-updated_at) fall back to created_at.
  const ref = item.updated_at ?? item.created_at;
  const updatedAt = Date.parse(ref);
  const now = Date.parse(services.now());
  if (Number.isFinite(updatedAt) && now - updatedAt > ttl * 1000) {
    return { ...item, status: "failed", error: { code: "stale_pending", message: `pending > ${ttl}s` } };
  }
  return item;
}

function expiredActiveAttempt(
  activeAttempt: ProcessingAttemptSummary | undefined,
  env: Env,
  services: Services,
): ProcessingAttemptSummary | null {
  if (activeAttempt?.status !== "running") return null;
  const ttl = pendingTtlSeconds(env);
  const startedAt = Date.parse(activeAttempt.started_at);
  const nowIso = services.now();
  const now = Date.parse(nowIso);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return null;
  if (now - startedAt <= ttl * 1000) return null;
  return {
    ...activeAttempt,
    status: "failed",
    finished_at: nowIso,
    error: {
      code: "stale_active_attempt",
      message: `active attempt > ${ttl}s`,
      ...(activeAttempt.stage ? { stage: activeAttempt.stage } : {}),
      failed_at: nowIso,
      retryable: true,
    },
  };
}

function pendingTtlSeconds(env: Env): number {
  const n = Number(env.PENDING_TTL_SECONDS);
  return Number.isFinite(n) ? n : 300;
}
