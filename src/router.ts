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
  type StoredByUrlPointer,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
import { defaultServices, sha256Hex, type Services } from "./services";

export interface AppOptions {
  services?: Services;
}

const MISSING_MANIFEST_OWNER_GRACE_MS = 5 * 60 * 1000;

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
    const existing = await reader.readByUrlPointerWithEtag(urlHash);
    if (existing) {
      const m = await reader.readManifest(existing.pointer.key_prefix);
      if (m && ownedManifestMatches(existing.pointer, m, url, urlHash)) {
        const result = await submitResultForOwnedReading(
          reader,
          c.env,
          services,
          existing.pointer,
          m,
          { email: parsed.data.email ?? true },
        );
        return c.json(result.body, result.status);
      }
      const result = await damagedOwnerResult(
        reader,
        c.env,
        services,
        url,
        urlHash,
        existing,
        parsed.data.email ?? true,
        { allowFreshInitializingConflict: !m },
      );
      return c.json(result.body, result.status);
    }

    const legacy = await reader.findManifestByUrl(url);
    if (legacy) {
      const pointer = { id: legacy.manifest.id, key_prefix: legacy.keyPrefix };
      try {
        await reader.writeByUrlPointer(urlHash, pointer, { ifNotExists: true });
        const result = await submitResultForOwnedReading(
          reader,
          c.env,
          services,
          pointer,
          legacy.manifest,
          { email: parsed.data.email ?? true },
        );
        return c.json(result.body, result.status);
      } catch (err) {
        if (!(err instanceof PointerExistsError)) throw err;
        const claimed = await reader.readByUrlPointerWithEtag(urlHash);
        if (claimed) {
          const claimedManifest = await reader.readManifest(claimed.pointer.key_prefix);
          if (claimedManifest && ownedManifestMatches(claimed.pointer, claimedManifest, url, urlHash)) {
            const result = await submitResultForOwnedReading(
              reader,
              c.env,
              services,
              claimed.pointer,
              claimedManifest,
              { email: parsed.data.email ?? true },
            );
            return c.json(result.body, result.status);
          }
          const result = await damagedOwnerResult(
            reader,
            c.env,
            services,
            url,
            urlHash,
            claimed,
            parsed.data.email ?? true,
            { allowFreshInitializingConflict: !claimedManifest },
          );
          return c.json(result.body, result.status);
        }
        throw err;
      }
    }

    const result = await createNewReadingForSubmit(
      reader,
      c.env,
      services,
      url,
      parsed.data.email ?? true,
    );
    return c.json(result.body, result.status);
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
      if (m && ownedManifestMatches(existing, m, url, urlHash)) {
        const result = await markdownImportResultForOwnedReading(
          reader,
          c.env,
          services,
          existing,
          m,
          parsed.data.markdown,
          parsed.data.title,
          parsed.data.email ?? false,
        );
        return c.json(result.body, result.status);
      }
    }

    const legacy = await reader.findManifestByUrl(
      url,
      existing ? { deepScan: true } : undefined,
    );
    if (legacy) {
      const pointer = { id: legacy.manifest.id, key_prefix: legacy.keyPrefix };
      try {
        await reader.writeByUrlPointer(urlHash, pointer, { ifNotExists: true });
        const result = await markdownImportResultForOwnedReading(
          reader,
          c.env,
          services,
          pointer,
          legacy.manifest,
          parsed.data.markdown,
          parsed.data.title,
          parsed.data.email ?? false,
        );
        return c.json(result.body, result.status);
      } catch (err) {
        if (!(err instanceof PointerExistsError)) throw err;
        const claimed = await reader.readByUrlPointerWithEtag(urlHash);
        if (claimed) {
          const claimedManifest = await reader.readManifest(claimed.pointer.key_prefix);
          if (claimedManifest && ownedManifestMatches(claimed.pointer, claimedManifest, url, urlHash)) {
            const result = await markdownImportResultForOwnedReading(
              reader,
              c.env,
              services,
              claimed.pointer,
              claimedManifest,
              parsed.data.markdown,
              parsed.data.title,
              parsed.data.email ?? false,
            );
            return c.json(result.body, result.status);
          }
          if (!claimedManifest && isFreshMissingManifestPointer(claimed.pointer, services.now())) {
            return c.json(
              {
                error: "reading owner is still initializing",
                id: claimed.pointer.id,
                poll: `/readings/${claimed.pointer.id}`,
              },
              409,
            );
          }
          const replaced = await reader.replaceByUrlPointerIfCurrent(
            urlHash,
            claimed.etag,
            pointer,
          );
          if (replaced) {
            const result = await markdownImportResultForOwnedReading(
              reader,
              c.env,
              services,
              pointer,
              legacy.manifest,
              parsed.data.markdown,
              parsed.data.title,
              parsed.data.email ?? false,
            );
            return c.json(result.body, result.status);
          }
        }
      }
    }

    const result = await createNewReadingForMarkdownImport(
      reader,
      c.env,
      services,
      url,
      parsed.data.markdown,
      parsed.data.title,
      parsed.data.email ?? false,
    );
    return c.json(result.body, result.status);
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

type SubmitJsonResult = {
  body: unknown;
  status: 200 | 202 | 409 | 503;
};

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
  url: string,
  email: boolean,
  claim: { replaceEtag?: string } = {},
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

  const pointer = { id: args.id, key_prefix: args.keyPrefix };
  try {
    if (claim.replaceEtag) {
      const replaced = await reader.replaceByUrlPointerIfCurrent(
        args.urlHash,
        claim.replaceEtag,
        pointer,
      );
      if (!replaced) throw new PointerExistsError(args.urlHash);
    } else {
      await reader.writeByUrlPointer(
        args.urlHash,
        pointer,
        { ifNotExists: true },
      );
    }
  } catch (err) {
    if (!(err instanceof PointerExistsError)) throw err;
    const claimed = await reader.readByUrlPointerWithEtag(args.urlHash);
    if (claimed) {
      const claimedManifest = await reader.readManifest(claimed.pointer.key_prefix);
      if (claimedManifest && ownedManifestMatches(claimed.pointer, claimedManifest, url, args.urlHash)) {
        return submitResultForOwnedReading(
          reader,
          env,
          services,
          claimed.pointer,
          claimedManifest,
          { email },
        );
      }
      return damagedOwnerResult(
        reader,
        env,
        services,
        url,
        args.urlHash,
        claimed,
        email,
        { allowFreshInitializingConflict: !claimedManifest },
      );
    }
    throw err;
  }

  await reader.writeManifest(args.keyPrefix, pendingManifest);
  await reader.writeByIdPointer(args.id, pointer);
  await reader.appendOrReplaceListIndexItem(
    manifestToIndexItem(pendingManifest, args.keyPrefix),
  );

  try {
    await env.READING_JOBS.send({
      ...args,
      attemptId,
      attemptStartedAt,
      trigger: "submit",
      email,
    });
  } catch (err) {
    console.error(err);
    const failedManifest = manifestForQueueSendFailure(
      pendingManifest,
      activeAttempt,
      err,
      services,
    );
    await reader.writeManifest(args.keyPrefix, failedManifest);
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(failedManifest, args.keyPrefix),
    );
    return {
      body: { error: "queue send failed", id: args.id },
      status: 503,
    };
  }

  return {
    body: {
      id: args.id,
      status: "pending",
      poll: `/readings/${args.id}`,
      attempt_id: attemptId,
    },
    status: 202,
  };
}

async function damagedOwnerResult(
  reader: ReadingStore,
  env: Env,
  services: Services,
  url: string,
  urlHash: string,
  owner: StoredByUrlPointer,
  email: boolean,
  opts: { allowFreshInitializingConflict: boolean },
): Promise<SubmitJsonResult> {
  if (
    !opts.allowFreshInitializingConflict ||
    !isFreshMissingManifestPointer(owner.pointer, services.now())
  ) {
    const legacy = await reader.findManifestByUrl(url, { deepScan: true });
    if (legacy) {
      const pointer = { id: legacy.manifest.id, key_prefix: legacy.keyPrefix };
      const replaced = await reader.replaceByUrlPointerIfCurrent(
        urlHash,
        owner.etag,
        pointer,
      );
      if (replaced) {
        return submitResultForOwnedReading(
          reader,
          env,
          services,
          pointer,
          legacy.manifest,
          { email },
        );
      }

      const current = await reader.readByUrlPointerWithEtag(urlHash);
      if (current) {
        const currentManifest = await reader.readManifest(current.pointer.key_prefix);
        if (currentManifest && ownedManifestMatches(current.pointer, currentManifest, url, urlHash)) {
          return submitResultForOwnedReading(
            reader,
            env,
            services,
            current.pointer,
            currentManifest,
            { email },
          );
        }
        return damagedOwnerResult(
          reader,
          env,
          services,
          url,
          urlHash,
          current,
          email,
          { allowFreshInitializingConflict: !currentManifest },
        );
      }
    }

    return createNewReadingForSubmit(reader, env, services, url, email, {
      replaceEtag: owner.etag,
    });
  }

  return {
    body: {
      error: "reading owner is still initializing",
      id: owner.pointer.id,
      poll: `/readings/${owner.pointer.id}`,
    },
    status: 409,
  };
}

function ownedManifestMatches(
  pointer: ByUrlPointer,
  manifest: Manifest,
  url: string,
  urlHash: string,
): boolean {
  return manifest.id === pointer.id && manifest.url === url && manifest.url_hash === urlHash;
}

function isFreshMissingManifestPointer(pointer: ByUrlPointer, nowIso: string): boolean {
  const createdAtMs = keyPrefixCreatedAtMs(pointer.key_prefix);
  if (createdAtMs === null) return false;
  const ageMs = Date.parse(nowIso) - createdAtMs;
  return ageMs >= 0 && ageMs < MISSING_MANIFEST_OWNER_GRACE_MS;
}

function keyPrefixCreatedAtMs(keyPrefix: string): number | null {
  const m = keyPrefix.match(
    /^readings\/(\d{4})\/(\d{2})\/(\d{2})T(\d{2})(\d{2})(\d{2})Z-/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
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

  await reader.writeManifest(pointer.key_prefix, nextManifest);
  await reader.appendOrReplaceListIndexItem(
    manifestToIndexItem(nextManifest, pointer.key_prefix),
  );

  try {
    await env.READING_JOBS.send(args);
  } catch (err) {
    console.error(err);
    const failedManifest = manifestForQueueSendFailure(
      effectiveManifest,
      activeAttempt,
      err,
      services,
    );
    await reader.writeManifest(pointer.key_prefix, failedManifest);
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(failedManifest, pointer.key_prefix),
    );
    return {
      body: { error: "queue send failed", id: effectiveManifest.id },
      status: 503,
    };
  }

  return {
    body: {
      id: effectiveManifest.id,
      status: nextManifest.status,
      poll: `/readings/${effectiveManifest.id}`,
      attempt_id: attemptId,
    },
    status: 202,
  };
}

async function createNewReadingForMarkdownImport(
  reader: ReadingStore,
  env: Env,
  services: Services,
  url: string,
  markdown: string,
  title: string | undefined,
  email: boolean,
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

  const pointer = { id: args.id, key_prefix: args.keyPrefix };
  try {
    await reader.writeByUrlPointer(args.urlHash, pointer, { ifNotExists: true });
  } catch (err) {
    if (!(err instanceof PointerExistsError)) throw err;
    const claimed = await reader.readByUrlPointerWithEtag(args.urlHash);
    if (claimed) {
      const claimedManifest = await reader.readManifest(claimed.pointer.key_prefix);
      if (claimedManifest && ownedManifestMatches(claimed.pointer, claimedManifest, url, args.urlHash)) {
        const effective = annotateStale(claimedManifest, env, services);
        if (effective.status !== "failed") return { body: effective, status: 200 };
        return enqueueMarkdownImport(
          reader,
          env,
          services,
          claimed.pointer,
          effective,
          markdown,
          title,
          email,
        );
      }
      if (!claimedManifest && isFreshMissingManifestPointer(claimed.pointer, services.now())) {
        return {
          body: {
            error: "reading owner is still initializing",
            id: claimed.pointer.id,
            poll: `/readings/${claimed.pointer.id}`,
          },
          status: 409,
        };
      }
      const replaced = await reader.replaceByUrlPointerIfCurrent(
        args.urlHash,
        claimed.etag,
        pointer,
      );
      if (replaced) {
        // Continue with this newly claimed import below.
      } else {
        return createNewReadingForMarkdownImport(
          reader,
          env,
          services,
          url,
          markdown,
          title,
          email,
        );
      }
    } else {
      throw err;
    }
    if (claimed) {
      // Ownership was repaired to `pointer`; fall through to write objects.
    } else {
      throw err;
    }
  }

  await reader.writeRaw(
    args.keyPrefix,
    "md",
    markdownBytes,
    "text/markdown; charset=utf-8",
  );
  await reader.writeExtracted(args.keyPrefix, markdown);
  await reader.writeManifest(args.keyPrefix, pendingManifest);
  await reader.writeByIdPointer(args.id, pointer);
  await reader.appendOrReplaceListIndexItem(
    manifestToIndexItem(pendingManifest, args.keyPrefix),
  );

  try {
    await env.READING_JOBS.send({
      ...args,
      attemptId,
      attemptStartedAt,
      trigger: "import",
      email,
    });
  } catch (err) {
    console.error(err);
    const failedManifest = manifestForQueueSendFailure(
      pendingManifest,
      activeAttempt,
      err,
      services,
    );
    await reader.writeManifest(args.keyPrefix, failedManifest);
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(failedManifest, args.keyPrefix),
    );
    return {
      body: { error: "queue send failed", id: args.id },
      status: 503,
    };
  }

  return {
    body: {
      id: args.id,
      status: "pending",
      poll: `/readings/${args.id}`,
      attempt_id: attemptId,
    },
    status: 202,
  };
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

  await reader.writeRaw(
    pointer.key_prefix,
    "md",
    markdownBytes,
    "text/markdown; charset=utf-8",
  );
  await reader.writeExtracted(pointer.key_prefix, markdown);
  await reader.writeManifest(pointer.key_prefix, pendingManifest);
  await reader.writeByIdPointer(effectiveManifest.id, pointer);
  await reader.appendOrReplaceListIndexItem(
    manifestToIndexItem(pendingManifest, pointer.key_prefix),
  );

  try {
    await env.READING_JOBS.send(args);
  } catch (err) {
    console.error(err);
    const failedManifest = manifestForQueueSendFailure(
      pendingManifest,
      activeAttempt,
      err,
      services,
    );
    await reader.writeManifest(pointer.key_prefix, failedManifest);
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(failedManifest, pointer.key_prefix),
    );
    return {
      body: { error: "queue send failed", id: effectiveManifest.id },
      status: 503,
    };
  }

  return {
    body: {
      id: effectiveManifest.id,
      status: pendingManifest.status,
      poll: `/readings/${effectiveManifest.id}`,
      attempt_id: attemptId,
    },
    status: 202,
  };
}

function manifestForQueueSendFailure(
  manifest: Manifest,
  activeAttempt: ProcessingAttemptSummary,
  err: unknown,
  services: Services,
): Manifest {
  const failedAt = services.now();
  const error = {
    code: "QueueSendError",
    message: err instanceof Error ? err.message : "queue send failed",
    stage: "queued" as const,
    failed_at: failedAt,
    retryable: true,
  };
  const failedAttempt: ProcessingAttemptSummary = {
    ...activeAttempt,
    status: "failed",
    stage: "queued",
    finished_at: failedAt,
    error,
  };

  if (manifest.status === "ready") {
    return {
      ...manifest,
      active_attempt: undefined,
      last_attempt: failedAttempt,
      updated_at: failedAt,
    };
  }

  return {
    ...manifest,
    status: "failed",
    active_attempt: undefined,
    last_attempt: failedAttempt,
    error,
    ...(manifest.status === "pending" ? { content_status: "failed" as const } : {}),
    updated_at: failedAt,
  };
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
