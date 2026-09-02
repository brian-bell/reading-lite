import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./index";
import {
  corsMiddleware,
  requireExpectedTenant,
  requirePrincipal,
  requireRecentAuth,
  requireScope,
  requireSession,
  type AppBindings,
} from "./middleware";
import { bindInternalDispatch, createMcpHandler, mcpOriginGuard } from "./mcp";
import {
  ListReadingsQuerySchema,
  PostReadingReprocessBodySchema,
  PostReadingsBodySchema,
  PostReadingsImportMarkdownBodySchema,
  PostReadingsSimilarBodySchema,
} from "./schemas/api";
import { readingStoreFor, ReadingStore } from "./modules/stores/reading-store";
import { similarityStoreFor } from "./modules/stores/similarity-store";
import { ReadingClaim } from "./modules/reading-claim";
import { defaultServices, type Services } from "./services";
import { readingIntakeFor, type IntakeOutcome, type ReadingIntake } from "./intake";
import { purgeReading } from "./reading-purge";
import type { AuthenticatedPrincipal } from "./control-plane/principal";
import { applyStaleness } from "./modules/staleness";
import {
  handleAuthChallenge,
  handleAuthLogout,
  handleAuthRedeem,
  handleDevMailbox,
  handleEmailChangeRequest,
  jsonAuth,
  type AuthRuntime,
} from "./control-plane/auth-handlers";
import {
  handleListSessions,
  handleRevokeAllSessions,
  handleRevokeSession,
} from "./control-plane/session-handlers";
import {
  handleCreateApiToken,
  handleListApiTokens,
  handleRevokeApiToken,
} from "./control-plane/token-handlers";
import { readAuthRoots } from "./control-plane/auth-root";
import { mintCsrfToken } from "./control-plane/csrf";
import { fromD1 } from "./control-plane/db";

export interface AppOptions {
  services?: Services;
  sleep?: (ms: number) => Promise<void>;
  auth?: AuthRuntime;
}

function storeForPrincipal(env: Env, principal: AuthenticatedPrincipal): ReadingStore {
  return readingStoreFor(env.READINGS_BUCKET, { tenantId: principal.tenantId }, env);
}

function intakeFor(env: Env, principal: AuthenticatedPrincipal, services: Services): ReadingIntake {
  return readingIntakeFor({
    reader: storeForPrincipal(env, principal),
    queue: env.READING_JOBS ?? null,
    services,
    pendingTtlSeconds: pendingTtlSeconds(env),
    principal,
  });
}

export function createApp(opts: AppOptions = {}) {
  const services = opts.services ?? defaultServices();
  const authRuntime = opts.auth ?? {};
  const app = new Hono<AppBindings>();

  app.use("*", corsMiddleware());

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  app.get("/health", (c) => c.text("ok", 200));

  const authNowMs = () => Date.parse(services.now());

  app.post("/api/auth/challenge", (c) => handleAuthChallenge(c, authNowMs(), authRuntime));
  app.post("/api/auth/redeem", (c) => handleAuthRedeem(c, authNowMs(), authRuntime));
  app.post("/api/auth/logout", (c) => handleAuthLogout(c, authNowMs()));
  app.use("/api/auth/sessions", requirePrincipal(authNowMs));
  app.use("/api/auth/sessions/*", requirePrincipal(authNowMs));
  app.get("/api/auth/sessions", (c) => handleListSessions(c, authNowMs()));
  app.post("/api/auth/sessions/revoke-all", (c) => handleRevokeAllSessions(c, authNowMs(), authRuntime));
  app.delete("/api/auth/sessions/:id", (c) => handleRevokeSession(c, authNowMs()));
  app.use("/api/auth/email-change", requirePrincipal(authNowMs), requireRecentAuth(authNowMs));
  app.post("/api/auth/email-change", (c) => handleEmailChangeRequest(c, authNowMs(), authRuntime));
  app.use("/api/auth/tokens", requirePrincipal(authNowMs), requireSession());
  app.use("/api/auth/tokens/*", requirePrincipal(authNowMs), requireSession());
  app.post("/api/auth/tokens", requireRecentAuth(authNowMs), (c) =>
    handleCreateApiToken(c, authNowMs(), authRuntime),
  );
  app.get("/api/auth/tokens", (c) => handleListApiTokens(c, authNowMs()));
  app.delete("/api/auth/tokens/:id", (c) => handleRevokeApiToken(c, authNowMs()));
  app.get("/api/dev/mailbox", (c) => handleDevMailbox(c));
  app.all("/api/auth/*", () => jsonAuth({ error: "method not allowed" }, 405));

  app.use("/mcp", mcpOriginGuard());
  app.use("/mcp", requirePrincipal(authNowMs));
  app.all("/mcp", createMcpHandler(bindInternalDispatch(app), { sleep: opts.sleep }));
  // Alias under /api/* so production works before the dedicated /mcp* zone
  // route is attached (that update needs Cloudflare zone Workers Routes
  // permission the deploy token may not have).
  app.use("/api/mcp", mcpOriginGuard());
  app.use("/api/mcp", requirePrincipal(authNowMs));
  app.all("/api/mcp", createMcpHandler(bindInternalDispatch(app), { sleep: opts.sleep }));

  // Authenticated routes: bearer token or host-only session cookie.
  app.use("/api/whoami", requirePrincipal(authNowMs));
  app.use("/api/readings", requirePrincipal(authNowMs), requireExpectedTenant());
  app.use("/api/readings/*", requirePrincipal(authNowMs), requireExpectedTenant());

  // The principal's own identity — no scope gate: every authenticated caller
  // may learn who it is. Operator tooling uses this to verify that a bearer
  // token acts as the tenant the operator selected before submitting writes
  // (reading-lite-1xk); see GetWhoamiResponseSchema for the contract.
  app.get("/api/whoami", async (c) => {
    const principal = c.get("principal");
    const user = await fromD1(c.env.CONTROL_PLANE).first<{ email_display: string }>(
      "SELECT email_display FROM users WHERE id = ?",
      String(principal.userId),
    );
    const body: {
      tenant_id: string;
      user_id: string;
      principal: AuthenticatedPrincipal["kind"];
      tenant_data_plane: boolean;
      email: string;
      csrf_token?: string;
    } = {
      tenant_id: String(principal.tenantId),
      user_id: String(principal.userId),
      principal: principal.kind,
      tenant_data_plane: c.env.TENANT_DATA_PLANE === "1",
      email: user?.email_display ?? "",
    };
    if (principal.kind === "session") {
      const roots = readAuthRoots(c.env);
      body.csrf_token = await mintCsrfToken(roots.authRoot, principal.sessionId);
    }
    return c.json(body);
  });

  app.post("/api/readings", requireScope("readings:write"), async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const intake = intakeFor(c.env, c.get("principal"), services);
    const out = await intake.submit(parsed.data.url, { email: parsed.data.email ?? true });
    const res = toHttp(out);
    return c.json(res.body, res.status);
  });

  app.post("/api/readings/import-markdown", requireScope("readings:import"), async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsImportMarkdownBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const intake = intakeFor(c.env, c.get("principal"), services);
    const out = await intake.importMarkdown(parsed.data.source_url, parsed.data.markdown, {
      title: parsed.data.title,
      email: parsed.data.email ?? false,
    });
    const res = toHttp(out);
    return c.json(res.body, res.status);
  });

  app.get("/api/readings", requireScope("readings:read"), async (c) => {
    const parsed = ListReadingsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid query", details: parsed.error.message }, 400);
    }
    const { q, tag, offset, limit } = parsed.data;
    const reader = storeForPrincipal(c.env, c.get("principal"));
    const out = await reader.listManifests({ q, tag, offset, limit });
    const annotated = out.readings.map((item) =>
      applyStaleness(item, pendingTtlSeconds(c.env), services.now()),
    );
    return c.json({
      readings: annotated,
      limit,
      offset,
      has_more: offset + annotated.length < out.total_filtered,
    });
  });

  app.get("/api/readings/lookup", requireScope("readings:read"), async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "missing url" }, 400);
    const reader = storeForPrincipal(c.env, c.get("principal"));
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
        const res = toHttp({ kind: "initializing", id: owner.pointer.id });
        return c.json(res.body, res.status);
      }
      case "unclaimed":
        return c.json({ error: "not found" }, 404);
    }
  });

  app.post("/api/readings/similar", requireScope("readings:write"), async (c) => {
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
    const similarity = similarityStoreFor(c.env.READINGS_INDEX, { tenantId: c.get("principal").tenantId }, c.env);
    const items = await similarity.query(parsed.data.query_embedding, parsed.data.k);
    return c.json({ items });
  });

  app.get("/api/readings/:id/diagnostics", requireScope("readings:read"), async (c) => {
    const id = c.req.param("id");
    const reader = storeForPrincipal(c.env, c.get("principal"));
    const ptr = await reader.readByIdPointer(id);
    if (!ptr) return c.json({ error: "not found" }, 404);
    const manifest = await reader.readManifest(ptr.key_prefix);
    if (!manifest) return c.json({ error: "not found" }, 404);
    const byUrl = await reader.readByUrlPointer(manifest.url_hash);
    const indexItem = await reader.findListIndexItem(id);
    const objects = await reader.listReadingObjects(ptr.key_prefix);
    const attempts = await reader.listAttempts(ptr.key_prefix, 20);
    const ttl = pendingTtlSeconds(c.env);
    return c.json({
      id,
      key_prefix: ptr.key_prefix,
      manifest: applyStaleness(manifest, ttl, services.now()),
      index_item: indexItem ? applyStaleness(indexItem, ttl, services.now()) : null,
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

  app.post("/api/readings/:id/reprocess", requireScope("readings:write"), async (c) => {
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
    const intake = intakeFor(c.env, c.get("principal"), services);
    const out = await intake.reprocess(c.req.param("id"), {
      force: parsed.data.force,
      email: parsed.data.email ?? false,
      source: parsed.data.source,
    });
    const res = toHttp(out);
    return c.json(res.body, res.status);
  });

  app.delete("/api/readings/:id", requireScope("readings:delete"), async (c) => {
    const id = c.req.param("id");
    const principal = c.get("principal");
    const reader = storeForPrincipal(c.env, principal);
    // Null without a Vectorize binding (local dev): the purge is R2-only there,
    // matching the rest of the router's degrade-in-dev stance.
    const similarity = c.env.READINGS_INDEX
      ? similarityStoreFor(c.env.READINGS_INDEX, { tenantId: principal.tenantId }, c.env)
      : null;
    const out = await purgeReading({ reader, similarity }, id, {
      pendingTtlSeconds: pendingTtlSeconds(c.env),
      now: services.now(),
    });
    switch (out.kind) {
      case "not_found":
        return c.json({ error: "not found" }, 404);
      case "conflict":
        return c.json({ error: "reading already has an active attempt" }, 409);
      case "purged":
        return c.json(out.report, 200);
    }
  });

  app.get("/api/readings/:id", requireScope("readings:read"), async (c) => {
    const id = c.req.param("id");
    const reader = storeForPrincipal(c.env, c.get("principal"));
    const found = await reader.loadReadingById(id);
    if (!found) return c.json({ error: "not found" }, 404);
    return c.json(applyStaleness(found.manifest, pendingTtlSeconds(c.env), services.now()));
  });

  app.get("/api/readings/:id/content", requireScope("readings:read"), async (c) => {
    const id = c.req.param("id");
    const reader = storeForPrincipal(c.env, c.get("principal"));
    const found = await reader.loadReadingById(id);
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.manifest.content_status !== "captured") {
      return c.json({ error: "extracted markdown not available" }, 404);
    }
    const obj = await reader.readExtracted(found.keyPrefix);
    if (!obj || !obj.body) return c.json({ error: "not found" }, 404);
    return new Response(obj.body, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  });

  app.get("/api/readings/:id/content/raw", requireScope("readings:read"), async (c) => {
    const id = c.req.param("id");
    const reader = storeForPrincipal(c.env, c.get("principal"));
    const found = await reader.loadReadingById(id);
    if (!found) return c.json({ error: "not found" }, 404);
    const ext = extFromContentType(found.manifest.content_type);
    const obj = await reader.readRaw(found.keyPrefix, ext);
    if (!obj || !obj.body) return c.json({ error: "not found" }, 404);
    return new Response(obj.body, {
      status: 200,
      headers: { "content-type": obj.contentType },
    });
  });

  return app;
}

// The 503 bodies the SPA and operator tooling match on — one message per
// retryable `unavailable` reason, byte-identical to the pre-intake router.
const UNAVAILABLE_MESSAGES: Record<
  Extract<IntakeOutcome, { kind: "unavailable" }>["reason"],
  string
> = {
  queue_unbound: "queue binding READING_JOBS is not configured",
  claim_contention: "could not claim url ownership under contention",
  owner_resolution_contention: "could not resolve url ownership under contention",
  activation_failed: "reading setup failed",
  queue_send_failed: "queue send failed",
};

// The single outcome → HTTP mapping. Reading intake is HTTP-free; everything
// status-code- or body-shaped about submit/import/reprocess lives here.
function toHttp(out: IntakeOutcome): {
  body: unknown;
  status: 200 | 202 | 404 | 409 | 503;
} {
  switch (out.kind) {
    case "activated":
      return {
        body: {
          id: out.id,
          status: out.status,
          poll: `/api/readings/${out.id}`,
          attempt_id: out.attemptId,
        },
        status: 202,
      };
    case "existing":
      return { body: out.manifest, status: 200 };
    case "initializing":
      return {
        body: {
          error: "reading owner is still initializing",
          id: out.id,
          poll: `/api/readings/${out.id}`,
        },
        status: 409,
      };
    case "conflict":
      return {
        body: {
          error:
            out.reason === "active_attempt"
              ? "reading already has an active attempt"
              : "markdown content not available",
        },
        status: 409,
      };
    case "not_found":
      return { body: { error: "not found" }, status: 404 };
    case "unavailable":
      return {
        body: {
          error: UNAVAILABLE_MESSAGES[out.reason],
          ...("id" in out && out.id !== undefined ? { id: out.id } : {}),
        },
        status: 503,
      };
  }
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

function pendingTtlSeconds(env: Env): number {
  const n = Number(env.PENDING_TTL_SECONDS);
  return Number.isFinite(n) ? n : 300;
}
