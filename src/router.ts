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
import type {
  ByUrlPointer,
  Manifest,
  ProcessingAttemptSummary,
} from "./schemas/manifest";
import {
  manifestToIndexItem,
  PointerExistsError,
  ReadingStore,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
import { defaultServices, sha256Hex, type Services } from "./services";

export interface AppOptions {
  services?: Services;
}

const submitLocks = new Map<string, Promise<void>>();

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

    return withSubmitLock(urlHash, async () => {
      const disposition = await resolveSubmitDisposition(
        reader,
        url,
        urlHash,
        c.env,
        services,
        undefined,
        { canEnqueue: c.env.READING_JOBS !== undefined },
      );
      if (disposition.kind === "return") return c.json(disposition.manifest, 200);
      if (disposition.kind === "claimed") {
        return c.json(
          {
            id: disposition.pointer.id,
            status: "pending",
            poll: `/readings/${disposition.pointer.id}`,
          },
          200,
        );
      }
      if (disposition.kind === "queue-unavailable") {
        return c.json(
          { error: "queue binding READING_JOBS is not configured" },
          503,
        );
      }
      if (!c.env.READING_JOBS) {
        return c.json(
          { error: "queue binding READING_JOBS is not configured" },
          503,
        );
      }
      if (disposition.kind === "reprocess") {
        const result = await enqueueReprocess(
          reader,
          c.env,
          services,
          disposition.pointer,
          disposition.manifest,
          { email: parsed.data.email ?? true },
        );
        return c.json(result.body, result.status);
      }

      const args = disposition.args;
      const attemptStartedAt = services.now();
      const attemptId = newAttemptId(services);
      const activeAttempt = newAttemptSummary(attemptId, "submit", attemptStartedAt);
      const pendingManifest = pendingManifestForNewReading(args, activeAttempt, {
        sourceType: "url",
        contentType: "application/octet-stream",
        contentBytes: 0,
        contentSha256: "0".repeat(64),
      });

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

    return withSubmitLock(urlHash, async () => {
      const source: ProcessReadingSource = {
        kind: "markdown",
        markdown: parsed.data.markdown,
        ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
      };
      const markdownDetails = await markdownContentDetails(parsed.data.markdown);
      const disposition = await resolveSubmitDisposition(
        reader,
        url,
        urlHash,
        c.env,
        services,
        source,
        { canEnqueue: c.env.READING_JOBS !== undefined },
      );
      if (disposition.kind === "return") return c.json(disposition.manifest, 200);
      if (disposition.kind === "claimed") {
        return c.json(
          {
            id: disposition.pointer.id,
            status: "pending",
            poll: `/readings/${disposition.pointer.id}`,
          },
          200,
        );
      }
      if (disposition.kind === "queue-unavailable") {
        return c.json(
          { error: "queue binding READING_JOBS is not configured" },
          503,
        );
      }
      if (!c.env.READING_JOBS) {
        return c.json(
          { error: "queue binding READING_JOBS is not configured" },
          503,
        );
      }
      if (disposition.kind === "reprocess") {
        const result = await enqueueReprocess(
          reader,
          c.env,
          services,
          disposition.pointer,
          disposition.manifest,
          {
            email: parsed.data.email ?? false,
            source,
            contentDetails: markdownDetails,
          },
        );
        return c.json(result.body, result.status);
      }

      const args = disposition.args;
      const attemptStartedAt = services.now();
      const attemptId = newAttemptId(services);
      const activeAttempt = newAttemptSummary(attemptId, "import", attemptStartedAt);
      const pendingManifest = pendingManifestForNewReading(args, activeAttempt, {
        sourceType: "markdown",
        ...markdownDetails,
        ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
      });

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
    // `wrangler dev` runs without a Vectorize binding (no local emulator), so
    // degrade to an empty result set rather than throwing a 500. In production
    // the binding is always present.
    if (!c.env.READINGS_INDEX) {
      return c.json({ items: [] });
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

    const result = await enqueueReprocess(reader, c.env, services, ptr, manifest, {
      force: parsed.data.force,
      email: parsed.data.email ?? false,
    });
    return c.json(result.body, result.status);
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

type SubmitDisposition =
  | { kind: "return"; manifest: Manifest }
  | { kind: "reprocess"; pointer: ByUrlPointer; manifest: Manifest }
  | { kind: "claimed"; pointer: ByUrlPointer }
  | { kind: "create"; args: ProcessReadingArgs }
  | { kind: "queue-unavailable" };

interface ResolveSubmitOptions {
  canEnqueue: boolean;
}

async function withSubmitLock<T>(urlHash: string, fn: () => Promise<T>): Promise<T> {
  const previous = submitLocks.get(urlHash) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  submitLocks.set(urlHash, current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (submitLocks.get(urlHash) === current) submitLocks.delete(urlHash);
  }
}

async function resolveSubmitDisposition(
  reader: ReadingStore,
  url: string,
  urlHash: string,
  env: Env,
  services: Services,
  source?: ProcessReadingSource,
  opts: ResolveSubmitOptions = { canEnqueue: true },
): Promise<SubmitDisposition> {
  const pointed = await dispositionFromPointer(
    reader,
    await reader.readByUrlPointer(urlHash),
    env,
    services,
  );
  if (pointed) return pointed;

  const legacy = await legacyDispositionFromList(reader, url, urlHash, env, services);
  if (legacy) return legacy;

  if (!opts.canEnqueue) return { kind: "queue-unavailable" };

  const args = await newReadingArgs(url, services, source);
  try {
    await reader.writeByUrlPointer(
      urlHash,
      { id: args.id, key_prefix: args.keyPrefix },
      { ifNotExists: true },
    );
    return { kind: "create", args };
  } catch (e) {
    if (!(e instanceof PointerExistsError)) throw e;
    const pointer = await reader.readByUrlPointer(urlHash);
    const raced = await dispositionFromPointer(reader, pointer, env, services);
    if (raced) return raced;

    if (pointer) return { kind: "claimed", pointer };

    // The pointer disappeared between the failed conditional put and our
    // follow-up read. Retry the claim once instead of minting another id.
    await reader.writeByUrlPointer(
      urlHash,
      { id: args.id, key_prefix: args.keyPrefix },
      { ifNotExists: true },
    );
    return { kind: "create", args };
  }
}

async function dispositionFromPointer(
  reader: ReadingStore,
  pointer: ByUrlPointer | null,
  env: Env,
  services: Services,
): Promise<SubmitDisposition | null> {
  if (!pointer) return null;
  const manifest = await reader.readManifest(pointer.key_prefix).catch(() => null);
  if (!manifest) return null;
  await reader.writeByIdPointer(pointer.id, pointer);
  const effectiveManifest = annotateStale(manifest, env, services);
  if (effectiveManifest.status === "failed") {
    return { kind: "reprocess", pointer, manifest: effectiveManifest };
  }
  return { kind: "return", manifest: effectiveManifest };
}

async function legacyDispositionFromList(
  reader: ReadingStore,
  url: string,
  urlHash: string,
  env: Env,
  services: Services,
): Promise<SubmitDisposition | null> {
  const index = await reader.readListIndex();
  const item = index?.items
    .filter((i) => i.url === url)
    .sort((a, b) => legacyItemRank(a, b))[0];
  if (!item) return null;

  const pointer: ByUrlPointer = { id: item.id, key_prefix: item.key_prefix };
  try {
    await reader.writeByUrlPointer(urlHash, pointer, { ifNotExists: true });
  } catch (e) {
    if (!(e instanceof PointerExistsError)) throw e;
    const existing = await dispositionFromPointer(
      reader,
      await reader.readByUrlPointer(urlHash),
      env,
      services,
    );
    if (existing) return existing;
    await reader.writeByUrlPointer(urlHash, pointer);
  }

  const manifest = await reader.readManifest(item.key_prefix).catch(() => null);
  if (!manifest) return null;
  await reader.writeByIdPointer(pointer.id, pointer);
  const effectiveManifest = annotateStale(manifest, env, services);
  if (effectiveManifest.status === "failed") return { kind: "reprocess", pointer, manifest: effectiveManifest };
  return { kind: "return", manifest: effectiveManifest };
}

function legacyItemRank(
  a: import("./schemas/api").ListIndexItem,
  b: import("./schemas/api").ListIndexItem,
): number {
  const statusRank = (status: string) => {
    if (status === "ready") return 0;
    if (status === "pending") return 1;
    if (status === "failed") return 2;
    return 3;
  };
  const ranked = statusRank(a.status) - statusRank(b.status);
  if (ranked !== 0) return ranked;
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

interface MarkdownContentDetails {
  contentType: string;
  contentBytes: number;
  contentSha256: string;
}

async function markdownContentDetails(markdown: string): Promise<MarkdownContentDetails> {
  return {
    contentType: "text/markdown; charset=utf-8",
    contentBytes: new TextEncoder().encode(markdown).byteLength,
    contentSha256: await sha256Hex(markdown),
  };
}

interface PendingManifestDetails extends MarkdownContentDetails {
  sourceType: "url" | "markdown";
  title?: string;
}

function pendingManifestForNewReading(
  args: ProcessReadingArgs,
  activeAttempt: ProcessingAttemptSummary,
  details: PendingManifestDetails,
): Manifest {
  return {
    id: args.id,
    url: args.url,
    url_hash: args.urlHash,
    source_type: details.sourceType,
    status: "pending",
    active_attempt: activeAttempt,
    ...(details.title === undefined ? {} : { title: details.title }),
    content_type: details.contentType,
    content_status: "captured",
    content_bytes: details.contentBytes,
    content_sha256: details.contentSha256,
    created_at: args.createdAt,
    updated_at: args.createdAt,
  };
}

interface ReprocessOptions {
  force?: boolean;
  email: boolean;
  source?: ProcessReadingSource;
  contentDetails?: MarkdownContentDetails;
}

async function enqueueReprocess(
  reader: ReadingStore,
  env: Env,
  services: Services,
  pointer: ByUrlPointer,
  manifest: Manifest,
  opts: ReprocessOptions,
): Promise<{
  status: 202 | 409 | 503;
  body: { error: string } | { id: string; status: string; poll: string; attempt_id: string };
}> {
  const effectiveManifest = annotateStale(manifest, env, services);
  if (effectiveManifest.active_attempt?.status === "running" && !opts.force) {
    return { status: 409, body: { error: "reading already has an active attempt" } };
  }
  if (!env.READING_JOBS) {
    return {
      status: 503,
      body: { error: "queue binding READING_JOBS is not configured" },
    };
  }

  const source = await sourceForReprocess(reader, pointer, effectiveManifest, opts.source);
  if (source === "missing-markdown") {
    return { status: 409, body: { error: "markdown content not available" } };
  }

  const attemptStartedAt = services.now();
  const attemptId = newAttemptId(services);
  const trigger = opts.source?.kind === "markdown" ? "import" : "reprocess";
  const activeAttempt = newAttemptSummary(attemptId, trigger, attemptStartedAt);
  const nextManifest = manifestForActiveAttempt(
    effectiveManifest,
    activeAttempt,
    services,
    opts.contentDetails
      ? {
          sourceType: "markdown",
          title: opts.source?.kind === "markdown" ? opts.source.title : undefined,
          ...opts.contentDetails,
        }
      : undefined,
  );

  const args: ProcessReadingArgs = {
    id: effectiveManifest.id,
    url: effectiveManifest.url,
    urlHash: effectiveManifest.url_hash,
    createdAt: effectiveManifest.created_at,
    keyPrefix: pointer.key_prefix,
    ...(source ? { source } : {}),
    attemptId,
    attemptStartedAt,
    trigger,
    preserveReadyManifest: effectiveManifest.status === "ready" ? effectiveManifest : undefined,
    email: opts.email,
  };

  await reader.writeManifest(pointer.key_prefix, nextManifest);
  await reader.appendOrReplaceListIndexItem(
    manifestToIndexItem(nextManifest, pointer.key_prefix),
  );

  await env.READING_JOBS.send(args);

  return {
    status: 202,
    body: {
      id: effectiveManifest.id,
      status: nextManifest.status,
      poll: `/readings/${effectiveManifest.id}`,
      attempt_id: attemptId,
    },
  };
}

async function sourceForReprocess(
  reader: ReadingStore,
  pointer: ByUrlPointer,
  manifest: Manifest,
  override?: ProcessReadingSource,
): Promise<ProcessReadingSource | undefined | "missing-markdown"> {
  if (override) return override;
  if (manifest.source_type !== "markdown") return undefined;
  const extracted = await reader.readExtracted(pointer.key_prefix);
  if (!extracted) return "missing-markdown";
  return {
    kind: "markdown",
    markdown: await extracted.text(),
    ...(manifest.title === undefined ? {} : { title: manifest.title }),
  };
}

function manifestForActiveAttempt(
  manifest: Manifest,
  activeAttempt: ProcessingAttemptSummary,
  services: Services,
  details?: PendingManifestDetails,
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
    source_type: details?.sourceType ?? manifest.source_type,
    status: "pending",
    active_attempt: activeAttempt,
    last_attempt: manifest.last_attempt,
    title: details?.title ?? manifest.title,
    content_type: details?.contentType ?? "application/octet-stream",
    content_status: "captured",
    content_bytes: details?.contentBytes ?? 0,
    content_sha256: details?.contentSha256 ?? "0".repeat(64),
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
