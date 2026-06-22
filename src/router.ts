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
  PointerExistsError,
  ReadingStore,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
import { OwnerResolutionContentionError, ReadingClaim } from "./modules/reading-claim";
import { defaultServices, sha256Hex, type Services } from "./services";
import { activateAttempt, type SubmitJsonResult } from "./attempt-activation";

export interface AppOptions {
  services?: Services;
}

export function createApp(opts: AppOptions = {}) {
  const services = opts.services ?? defaultServices();
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", corsMiddleware());

  app.onError((err, c) => {
    console.error(err);
    // Bounded ownership-resolution contention is retryable, not an internal
    // fault — surface it as 503 (mirroring claimByUrlSlot's own exhaustion)
    // rather than letting the generic 500 mask a "retry me" condition.
    if (err instanceof OwnerResolutionContentionError) {
      return c.json({ error: "could not resolve url ownership under contention" }, 503);
    }
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
    const email = parsed.data.email ?? true;

    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const claim = new ReadingClaim(reader, services);
    const owner = await claim.resolveOwner(url);
    switch (owner.kind) {
      case "owned": {
        const result = await submitResultForOwnedReading(
          reader,
          c.env,
          services,
          owner.pointer,
          owner.manifest,
          { email },
        );
        return c.json(result.body, result.status);
      }
      case "initializing": {
        const result = initializingResponse(owner.pointer.id);
        return c.json(result.body, result.status);
      }
      case "unclaimed": {
        const result = await createNewReadingForSubmit(
          reader,
          c.env,
          services,
          claim,
          url,
          email,
          { replaceEtag: owner.replaceEtag },
        );
        return c.json(result.body, result.status);
      }
    }
  });

  app.post("/readings/import-markdown", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsImportMarkdownBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }

    const url = parsed.data.source_url;
    const markdown = parsed.data.markdown;
    const title = parsed.data.title;
    const email = parsed.data.email ?? false;

    const reader = new ReadingStore(c.env.READINGS_BUCKET);
    const claim = new ReadingClaim(reader, services);
    const owner = await claim.resolveOwner(url);
    switch (owner.kind) {
      case "owned": {
        const result = await markdownImportResultForOwnedReading(
          reader,
          c.env,
          services,
          owner.pointer,
          owner.manifest,
          markdown,
          title,
          email,
        );
        return c.json(result.body, result.status);
      }
      case "initializing": {
        const result = initializingResponse(owner.pointer.id);
        return c.json(result.body, result.status);
      }
      case "unclaimed": {
        const result = await createNewReadingForMarkdownImport(
          reader,
          c.env,
          services,
          claim,
          url,
          markdown,
          title,
          email,
          { replaceEtag: owner.replaceEtag },
        );
        return c.json(result.body, result.status);
      }
    }
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
    const claim = new ReadingClaim(reader, services);
    // Read-only: a GET must be side-effect-free and cheap, so a lookup neither
    // claims a cold pointerless legacy nor repairs a damaged pointer (both are
    // R2 writes, and repair triggers a full-bucket deep scan). Only a live,
    // valid pointer resolves; anything else is "not found", leaving repair to
    // the next write (submit/import).
    const owner = await claim.resolveOwner(url, {
      claimColdLegacy: false,
      repairDamaged: false,
    });
    switch (owner.kind) {
      case "owned":
        return c.json({ id: owner.pointer.id });
      case "initializing": {
        const result = initializingResponse(owner.pointer.id);
        return c.json(result.body, result.status);
      }
      case "unclaimed":
        return c.json({ error: "not found" }, 404);
    }
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
    const result = await enqueueReprocess(
      reader,
      c.env,
      services,
      ptr,
      manifest,
      { force: parsed.data.force, email: parsed.data.email ?? false },
    );
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

async function submitResultForOwnedReading(
  reader: ReadingStore,
  env: Env,
  services: Services,
  pointer: ByUrlPointer,
  manifest: Manifest,
  opts: { email: boolean },
): Promise<SubmitJsonResult> {
  await reader.writeByIdPointer(pointer.id, pointer);
  const effectiveManifest = annotateStale(manifest, env, services);
  if (effectiveManifest.status !== "failed") {
    return { body: effectiveManifest, status: 200 };
  }
  return enqueueReprocess(reader, env, services, pointer, effectiveManifest, {
    email: opts.email,
  });
}

async function createNewReadingForSubmit(
  reader: ReadingStore,
  env: Env,
  services: Services,
  claim: ReadingClaim,
  url: string,
  email: boolean,
  opts: { replaceEtag?: string } = {},
): Promise<SubmitJsonResult> {
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
  if (!env.READING_JOBS) {
    return {
      body: { error: "queue binding READING_JOBS is not configured" },
      status: 503,
    };
  }
  const queue = env.READING_JOBS;

  const pointer = { id: args.id, key_prefix: args.keyPrefix };
  const claimed = await claimByUrlSlot(reader, claim, url, args.urlHash, pointer, {
    replaceEtag: opts.replaceEtag,
    onOwned: (res) =>
      submitResultForOwnedReading(reader, env, services, res.pointer, res.manifest, {
        email,
      }),
  });
  if (!claimed.ok) return claimed.result;

  return activateAttempt(reader, queue, services, {
    keyPrefix: args.keyPrefix,
    manifest: pendingManifest,
    writeByIdPointer: true,
    rollbackManifest: pendingManifest,
    rollbackAttempt: activeAttempt,
    queueMessage: { ...args, attemptId, attemptStartedAt, trigger: "submit", email },
  });
}

// Bounds the claim → re-resolve retry when a concurrent submit wins the by-url
// slot from under us. The original protocol recursed without limit; the resolver
// converges in practice within one or two reads, so a small cap is a safety net
// against pathological contention rather than a tuning knob.
const CLAIM_MAX_ATTEMPTS = 4;

type ClaimSlotResult =
  | { ok: true }
  | { ok: false; result: SubmitJsonResult };

// Claims the by-url slot for a freshly-minted reading, retrying through the
// resolver when a concurrent writer wins the race. Returns `{ ok: true }` once
// the slot is ours to write into, or `{ ok: false, result }` to defer to the
// winning owner (`onOwned`), report a still-initializing owner (409), or give up
// under persistent contention (503 — distinct from a settled owner, so the
// client retries rather than polling a reading that was never written).
async function claimByUrlSlot(
  reader: ReadingStore,
  claim: ReadingClaim,
  url: string,
  urlHash: string,
  pointer: ByUrlPointer,
  opts: {
    replaceEtag?: string;
    onOwned: (res: { pointer: ByUrlPointer; manifest: Manifest }) => Promise<SubmitJsonResult>;
  },
): Promise<ClaimSlotResult> {
  let replaceEtag = opts.replaceEtag;
  for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt++) {
    try {
      if (replaceEtag) {
        const replaced = await reader.replaceByUrlPointerIfCurrent(urlHash, replaceEtag, pointer);
        if (!replaced) throw new PointerExistsError(urlHash);
      } else {
        await reader.writeByUrlPointer(urlHash, pointer, { ifNotExists: true });
      }
      return { ok: true };
    } catch (err) {
      if (!(err instanceof PointerExistsError)) throw err;
      // Lost the slot — re-resolve and defer to whoever now owns it, or retry
      // the claim against the (possibly damaged) pointer they left behind.
      const res = await claim.resolveOwner(url);
      if (res.kind === "owned") return { ok: false, result: await opts.onOwned(res) };
      if (res.kind === "initializing") {
        return { ok: false, result: initializingResponse(res.pointer.id) };
      }
      replaceEtag = res.replaceEtag;
    }
  }
  return {
    ok: false,
    result: {
      body: { error: "could not claim url ownership under contention" },
      status: 503,
    },
  };
}

function initializingResponse(id: string): SubmitJsonResult {
  return {
    body: {
      error: "reading owner is still initializing",
      id,
      poll: `/readings/${id}`,
    },
    status: 409,
  };
}

async function markdownImportResultForOwnedReading(
  reader: ReadingStore,
  env: Env,
  services: Services,
  pointer: ByUrlPointer,
  manifest: Manifest,
  markdown: string,
  title: string | undefined,
  email: boolean,
): Promise<SubmitJsonResult> {
  const effective = annotateStale(manifest, env, services);
  if (effective.status !== "failed") return { body: effective, status: 200 };
  return enqueueMarkdownImport(
    reader,
    env,
    services,
    pointer,
    effective,
    markdown,
    title,
    email,
  );
}

async function enqueueReprocess(
  reader: ReadingStore,
  env: Env,
  services: Services,
  pointer: ByUrlPointer,
  manifest: Manifest,
  opts: { force?: boolean; email: boolean },
): Promise<SubmitJsonResult> {
  const effectiveManifest = annotateStale(manifest, env, services);
  if (effectiveManifest.active_attempt?.status === "running" && !opts.force) {
    return { body: { error: "reading already has an active attempt" }, status: 409 };
  }
  if (!env.READING_JOBS) {
    return {
      body: { error: "queue binding READING_JOBS is not configured" },
      status: 503,
    };
  }
  const queue = env.READING_JOBS;

  const attemptStartedAt = services.now();
  const attemptId = newAttemptId(services);
  const activeAttempt = newAttemptSummary(attemptId, "reprocess", attemptStartedAt);
  let source: ProcessReadingSource | undefined;
  if (effectiveManifest.source_type === "markdown") {
    const extracted = await reader.readExtracted(pointer.key_prefix);
    if (!extracted) {
      return { body: { error: "markdown content not available" }, status: 409 };
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
    keyPrefix: pointer.key_prefix,
    source,
    attemptId,
    attemptStartedAt,
    trigger: "reprocess",
    preserveReadyManifest: effectiveManifest.status === "ready" ? effectiveManifest : undefined,
    email: opts.email,
  };
  const nextManifest = manifestForActiveAttempt(effectiveManifest, activeAttempt, services);

  return activateAttempt(reader, queue, services, {
    keyPrefix: pointer.key_prefix,
    manifest: nextManifest,
    writeByIdPointer: false,
    rollbackManifest: effectiveManifest,
    rollbackAttempt: activeAttempt,
    queueMessage: args,
  });
}

async function createNewReadingForMarkdownImport(
  reader: ReadingStore,
  env: Env,
  services: Services,
  claim: ReadingClaim,
  url: string,
  markdown: string,
  title: string | undefined,
  email: boolean,
  opts: { replaceEtag?: string } = {},
): Promise<SubmitJsonResult> {
  const source: ProcessReadingSource = {
    kind: "markdown",
    markdown,
    ...(title === undefined ? {} : { title }),
  };
  const args = await newReadingArgs(url, services, source);
  const attemptStartedAt = services.now();
  const attemptId = newAttemptId(services);
  const activeAttempt = newAttemptSummary(attemptId, "import", attemptStartedAt);
  const markdownBytes = new TextEncoder().encode(markdown);
  const pendingManifest: Manifest = {
    id: args.id,
    url,
    url_hash: args.urlHash,
    source_type: "markdown",
    status: "pending",
    active_attempt: activeAttempt,
    ...(title === undefined ? {} : { title }),
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: markdownBytes.byteLength,
    content_sha256: await sha256Hex(markdown),
    created_at: args.createdAt,
    updated_at: args.createdAt,
  };
  if (!env.READING_JOBS) {
    return {
      body: { error: "queue binding READING_JOBS is not configured" },
      status: 503,
    };
  }
  const queue = env.READING_JOBS;

  const pointer = { id: args.id, key_prefix: args.keyPrefix };
  const claimed = await claimByUrlSlot(reader, claim, url, args.urlHash, pointer, {
    replaceEtag: opts.replaceEtag,
    onOwned: (res) =>
      markdownImportResultForOwnedReading(
        reader,
        env,
        services,
        res.pointer,
        res.manifest,
        markdown,
        title,
        email,
      ),
  });
  if (!claimed.ok) return claimed.result;

  return activateAttempt(reader, queue, services, {
    keyPrefix: args.keyPrefix,
    manifest: pendingManifest,
    writeByIdPointer: true,
    artifacts: {
      rawExt: "md",
      rawBytes: markdownBytes,
      rawContentType: "text/markdown; charset=utf-8",
      extractedMarkdown: markdown,
    },
    rollbackManifest: pendingManifest,
    rollbackAttempt: activeAttempt,
    queueMessage: { ...args, attemptId, attemptStartedAt, trigger: "import", email },
  });
}

async function enqueueMarkdownImport(
  reader: ReadingStore,
  env: Env,
  services: Services,
  pointer: ByUrlPointer,
  manifest: Manifest,
  markdown: string,
  title: string | undefined,
  email: boolean,
): Promise<SubmitJsonResult> {
  const effectiveManifest = annotateStale(manifest, env, services);
  if (
    effectiveManifest.status !== "failed" &&
    effectiveManifest.active_attempt?.status === "running"
  ) {
    return { body: { error: "reading already has an active attempt" }, status: 409 };
  }
  if (!env.READING_JOBS) {
    return {
      body: { error: "queue binding READING_JOBS is not configured" },
      status: 503,
    };
  }
  const queue = env.READING_JOBS;

  const attemptStartedAt = services.now();
  const attemptId = newAttemptId(services);
  const activeAttempt = newAttemptSummary(attemptId, "import", attemptStartedAt);
  const markdownTitle = title ?? effectiveManifest.title;
  const markdownBytes = new TextEncoder().encode(markdown);
  const source: ProcessReadingSource = {
    kind: "markdown",
    markdown,
    ...(markdownTitle === undefined ? {} : { title: markdownTitle }),
  };
  const args: ProcessReadingArgs = {
    id: effectiveManifest.id,
    url: effectiveManifest.url,
    urlHash: effectiveManifest.url_hash,
    createdAt: effectiveManifest.created_at,
    keyPrefix: pointer.key_prefix,
    source,
    attemptId,
    attemptStartedAt,
    trigger: "import",
    email,
  };
  const manifestWithoutError: Manifest = { ...effectiveManifest };
  delete manifestWithoutError.error;
  delete manifestWithoutError.active_attempt;
  const pendingManifest: Manifest = {
    ...manifestWithoutError,
    source_type: "markdown",
    status: "pending",
    active_attempt: activeAttempt,
    ...(markdownTitle === undefined ? {} : { title: markdownTitle }),
    content_type: "text/markdown; charset=utf-8",
    content_status: "captured",
    content_bytes: markdownBytes.byteLength,
    content_sha256: await sha256Hex(markdown),
    updated_at: attemptStartedAt,
  };

  return activateAttempt(reader, queue, services, {
    keyPrefix: pointer.key_prefix,
    manifest: pendingManifest,
    writeByIdPointer: true,
    artifacts: {
      rawExt: "md",
      rawBytes: markdownBytes,
      rawContentType: "text/markdown; charset=utf-8",
      extractedMarkdown: markdown,
    },
    rollbackManifest: pendingManifest,
    rollbackAttempt: activeAttempt,
    queueMessage: args,
  });
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
