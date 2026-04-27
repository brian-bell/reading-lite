import { Hono } from "hono";
import type { Env } from "./index";
import { corsMiddleware, requireBearer } from "./middleware";
import {
  newReadingArgs,
  processReading,
} from "./process-reading";
import {
  ListReadingsQuerySchema,
  PostReadingsBodySchema,
  PostReadingsSimilarBodySchema,
} from "./schemas/api";
import type { Manifest } from "./schemas/manifest";
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
    const pendingManifest: Manifest = {
      id: args.id,
      url,
      url_hash: args.urlHash,
      status: "pending",
      content_type: "application/octet-stream",
      content_status: "captured",
      content_bytes: 0,
      content_sha256: "0".repeat(64),
      created_at: args.createdAt,
      updated_at: args.createdAt,
    };
    await reader.writeManifest(args.keyPrefix, pendingManifest);
    await reader.writeByIdPointer(args.id, { id: args.id, key_prefix: args.keyPrefix });
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(pendingManifest, args.keyPrefix),
    );

    c.executionCtx.waitUntil(processReading(args, c.env, services));

    return c.json(
      { id: args.id, status: "pending", poll: `/readings/${args.id}` },
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

function extFromContentType(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}

function annotateStale(manifest: Manifest, env: Env, services: Services): Manifest {
  if (manifest.status !== "pending") return manifest;
  const ttl = (() => {
    const n = Number(env.PENDING_TTL_SECONDS);
    return Number.isFinite(n) ? n : 300;
  })();
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
  if (item.status !== "pending") return item;
  const ttl = (() => {
    const n = Number(env.PENDING_TTL_SECONDS);
    return Number.isFinite(n) ? n : 300;
  })();
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

