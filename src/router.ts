import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
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
  DESK_CAP,
  INBOX_BODY_MAX_BYTES,
  INBOX_ITEM_CAP,
  GetDeskQuerySchema,
  INBOX_STAGE_BUDGET_BYTES,
  ListReadingsQuerySchema,
  PostDeskBodySchema,
  PostInboxBodySchema,
  PostInboxPromoteBodySchema,
  PostReadingReprocessBodySchema,
  PostReadingsBodySchema,
  PostReadingsImportMarkdownBodySchema,
  PostReadingsSimilarBodySchema,
  type DeskFullResponse,
  type DeskNotReadyResponse,
  type DeskWriteResponse,
  type GetDeskResponse,
  type GetReadingRelationshipsResponse,
  type GetReadingResponse,
  type GetWhoamiResponse,
  type ListInboxResponse,
  type PostInboxExistingResponse,
  type PostInboxStagedResponse,
} from "./schemas/api";
import {
  projectRelationshipGraph,
  projectRelationshipTargets,
  relationshipTargetIds,
} from "./modules/relationship-targets";
import { sqlScope } from "./modules/db/request-sql";
import type { Sql } from "./modules/db/sql";
import { contentStoreFor, type ContentStore, type RawObject } from "./modules/stores/content-store";
import { pgReadingStoreFor, type ContentKeys, type PgReadingStore } from "./modules/stores/postgres/reading-store";
import { pgReadingWriterFor } from "./modules/stores/postgres/reading-writer";
import { pgInboxStoreFor } from "./modules/stores/postgres/inbox-store";
import { pgDeskStoreFor } from "./modules/stores/postgres/desk-store";
import { inboxMessageBytes, stageInboxItem, type InboxStageOutcome } from "./inbox/stage";
import { promoteInboxItem, type InboxPromoteOutcome } from "./inbox/promote";
import { pgSimilarityStoreFor } from "./modules/stores/postgres/similarity-store";
import { defaultServices, type Services } from "./services";
import { readingIntakeFor, type IntakeOutcome, type ReadingIntake } from "./intake";
import { purgeReading } from "./reading-purge";
import type { AuthenticatedPrincipal } from "./control-plane/principal";
import { applyStaleness, pendingTtlSeconds as parsePendingTtlSeconds } from "./modules/staleness";
import {
  handleAuthChallenge,
  handleAuthLogout,
  handleAuthRedeem,
  handleDevMailbox,
  handleEmailChangeRequest,
  handleLoginOptions,
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
import { handleGetSettings, handlePostSettings } from "./control-plane/settings-handlers";
import {
  handleConnectAnthropicKey,
  handleConnectProviderKey,
  handleDeleteAnthropicKey,
  handleDeleteProviderKey,
  handleGetProviderSettings,
  handleGetProviderUsage,
  handleUpdateProviderPreferences,
} from "./control-plane/provider-settings-handlers";
import { handleDeleteAccount } from "./control-plane/account-handlers";
import {
  handleDownloadArchiveExport,
  handleGetLatestArchiveExport,
  handlePostArchiveExport,
} from "./control-plane/archive-export-handlers";
import { readAuthRoots } from "./control-plane/auth-root";
import { mintCsrfToken } from "./control-plane/csrf";
import { fromSql } from "./control-plane/db";
import { providerKeyNeeded } from "./control-plane/tenant-provider-keys";
import { tenantUsageFor } from "./control-plane/tenant-usage-guard";

export interface AppOptions {
  services?: Services;
  auth?: AuthRuntime;
}

// The three tenant-scoped stores behind every reading route: rows to read,
// rows to write, and the R2 bytes the rows point at. Built from the principal's
// validated tenant and the request's one PostgreSQL client.
function storesFor(env: Env, principal: AuthenticatedPrincipal, sql: Sql) {
  const tenant = { tenantId: principal.tenantId };
  return {
    store: pgReadingStoreFor(sql, tenant),
    writer: pgReadingWriterFor(sql, tenant),
    content: contentStoreFor(env.READINGS_BUCKET, tenant, env),
  };
}

function intakeFor(env: Env, principal: AuthenticatedPrincipal, services: Services, sql: Sql): ReadingIntake {
  return readingIntakeFor({
    ...storesFor(env, principal, sql),
    queue: env.READING_JOBS ?? null,
    services,
    pendingTtlSeconds: pendingTtlSeconds(env),
    principal,
    usage: tenantUsageFor(env, String(principal.tenantId)),
    providerKeyNeeded: () => providerKeyNeeded(env, fromSql(sql), String(principal.tenantId)),
  });
}

function inboxFor(principal: AuthenticatedPrincipal, services: Services, sql: Sql) {
  return pgInboxStoreFor(sql, { tenantId: principal.tenantId }, services);
}

function deskFor(principal: AuthenticatedPrincipal, services: Services, sql: Sql) {
  return pgDeskStoreFor(sql, { tenantId: principal.tenantId }, services);
}

function deskBody(desk: string[]): DeskWriteResponse {
  return { desk };
}

export function createApp(opts: AppOptions = {}) {
  const services = opts.services ?? defaultServices();
  const authRuntime = opts.auth ?? {};
  const app = new Hono<AppBindings>();

  app.use("*", corsMiddleware());
  // One PostgreSQL client per request, shared by authentication and the
  // handler, and closed once the response is built. It connects on first use,
  // so /health and a refused preflight never open one.
  app.use("*", sqlScope);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  app.get("/health", (c) => c.text("ok", 200));

  const authNowMs = () => Date.parse(services.now());

  app.get("/api/auth/login-options", (c) => handleLoginOptions(c));
  app.post("/api/auth/challenge", (c) => handleAuthChallenge(c, authNowMs(), authRuntime));
  app.post("/api/auth/redeem", (c) => handleAuthRedeem(c, authNowMs(), authRuntime));
  app.post("/api/auth/logout", (c) => handleAuthLogout(c, authNowMs()));
  app.use("/api/auth/sessions", requirePrincipal(authNowMs), requireExpectedTenant());
  app.use("/api/auth/sessions/*", requirePrincipal(authNowMs), requireExpectedTenant());
  app.get("/api/auth/sessions", (c) => handleListSessions(c, authNowMs()));
  app.post("/api/auth/sessions/revoke-all", (c) => handleRevokeAllSessions(c, authNowMs(), authRuntime));
  app.delete("/api/auth/sessions/:id", (c) => handleRevokeSession(c, authNowMs()));
  app.use(
    "/api/auth/email-change",
    requirePrincipal(authNowMs),
    requireExpectedTenant(),
    requireRecentAuth(authNowMs),
  );
  app.post("/api/auth/email-change", (c) => handleEmailChangeRequest(c, authNowMs(), authRuntime));
  app.use("/api/auth/tokens", requirePrincipal(authNowMs), requireSession(), requireExpectedTenant());
  app.use("/api/auth/tokens/*", requirePrincipal(authNowMs), requireSession(), requireExpectedTenant());
  app.post("/api/auth/tokens", requireRecentAuth(authNowMs), (c) =>
    handleCreateApiToken(c, authNowMs(), authRuntime),
  );
  app.get("/api/auth/tokens", (c) => handleListApiTokens(c, authNowMs()));
  app.delete("/api/auth/tokens/:id", (c) => handleRevokeApiToken(c, authNowMs()));
  app.use("/api/auth/settings", requirePrincipal(authNowMs), requireSession(), requireExpectedTenant());
  app.get("/api/auth/settings", (c) => handleGetSettings(c));
  app.post("/api/auth/settings", (c) => handlePostSettings(c, authNowMs()));
  app.use("/api/auth/provider", requirePrincipal(authNowMs), requireSession(), requireExpectedTenant());
  app.use("/api/auth/provider/*", requirePrincipal(authNowMs), requireSession(), requireExpectedTenant());
  app.get("/api/auth/provider", (c) => handleGetProviderSettings(c));
  app.post("/api/auth/provider", requireRecentAuth(authNowMs), (c) =>
    handleConnectProviderKey(c, authNowMs(), services.fetch),
  );
  app.delete("/api/auth/provider", requireRecentAuth(authNowMs), (c) => handleDeleteProviderKey(c));
  app.post("/api/auth/provider/anthropic", requireRecentAuth(authNowMs), (c) =>
    handleConnectAnthropicKey(c, authNowMs(), services.fetch),
  );
  app.delete("/api/auth/provider/anthropic", requireRecentAuth(authNowMs), (c) => handleDeleteAnthropicKey(c));
  app.post("/api/auth/provider/preferences", (c) => handleUpdateProviderPreferences(c, authNowMs()));
  app.get("/api/auth/provider/usage", (c) => handleGetProviderUsage(c));
  app.get("/api/dev/mailbox", (c) => handleDevMailbox(c));
  app.all("/api/auth/*", () => jsonAuth({ error: "method not allowed" }, 405));

  // Account deletion suppress (195a). Session cookie + CSRF (via requirePrincipal)
  // + requireSession + optional x-expected-tenant pin + requireRecentAuth + body
  // `{ confirm: "delete" }`. The pin runs before recent-auth so a tab showing
  // another account gets 412, not a step-up for the account it isn't showing.
  // Bearer 403. Not DELETE /api/readings/:id. Founder is a normal tenant.
  app.use(
    "/api/account",
    requirePrincipal(authNowMs),
    requireSession(),
    requireExpectedTenant(),
    requireRecentAuth(authNowMs),
  );
  app.delete("/api/account", (c) => handleDeleteAccount(c, authNowMs(), authRuntime));

  // Archive export stays off /api/account: that mount forces recent-auth.
  // Session cookie only (bearer 403). CSRF is requirePrincipal on POST.
  app.use("/api/exports", requirePrincipal(authNowMs), requireSession(), requireExpectedTenant());
  app.use("/api/exports/*", requirePrincipal(authNowMs), requireSession(), requireExpectedTenant());
  app.post("/api/exports", (c) => handlePostArchiveExport(c, authNowMs()));
  app.get("/api/exports/latest", (c) => handleGetLatestArchiveExport(c, authNowMs()));
  app.get("/api/exports/:id/download", (c) => handleDownloadArchiveExport(c, authNowMs()));

  app.use("/mcp", mcpOriginGuard());
  app.use("/mcp", requirePrincipal(authNowMs));
  app.all("/mcp", createMcpHandler(bindInternalDispatch(app)));
  // Alias under /api/* so production works before the dedicated /mcp* zone
  // route is attached (that update needs Cloudflare zone Workers Routes
  // permission the deploy token may not have).
  app.use("/api/mcp", mcpOriginGuard());
  app.use("/api/mcp", requirePrincipal(authNowMs));
  app.all("/api/mcp", createMcpHandler(bindInternalDispatch(app)));

  // Authenticated routes: bearer token or host-only session cookie.
  app.use("/api/whoami", requirePrincipal(authNowMs));
  app.use("/api/readings", requirePrincipal(authNowMs), requireExpectedTenant());
  app.use("/api/readings/*", requirePrincipal(authNowMs), requireExpectedTenant());
  app.use("/api/inbox", requirePrincipal(authNowMs), requireExpectedTenant());
  app.use("/api/inbox/*", requirePrincipal(authNowMs), requireExpectedTenant());
  app.use("/api/desk", requirePrincipal(authNowMs), requireExpectedTenant());
  app.use("/api/desk/*", requirePrincipal(authNowMs), requireExpectedTenant());

  // The principal's own identity — no scope gate: every authenticated caller
  // may learn who it is. Operator tooling uses this to verify that a bearer
  // token acts as the tenant the operator selected before submitting writes
  // (reading-lite-1xk); see GetWhoamiResponseSchema for the contract.
  app.get("/api/whoami", async (c) => {
    const principal = c.get("principal");
    const db = fromSql(c.get("sql"));
    const user = await db.first<{ email_display: string }>(
      "SELECT email_display FROM users WHERE id = ?",
      String(principal.userId),
    );
    const keyNeeded = await providerKeyNeeded(c.env, db, String(principal.tenantId));
    const body: GetWhoamiResponse = {
      tenant_id: String(principal.tenantId),
      user_id: String(principal.userId),
      principal: principal.kind,
      tenant_data_plane: c.env.TENANT_DATA_PLANE === "1",
      needs_provider_key: keyNeeded !== null,
      provider_key_provider: keyNeeded,
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
    const intake = intakeFor(c.env, c.get("principal"), services, c.get("sql"));
    const out = await intake.submit(parsed.data.url, { email: parsed.data.email ?? true });
    return respondIntake(c, out);
  });

  app.post("/api/readings/import-markdown", requireScope("readings:import"), async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsImportMarkdownBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const intake = intakeFor(c.env, c.get("principal"), services, c.get("sql"));
    const out = await intake.importMarkdown(parsed.data.source_url, parsed.data.markdown, {
      title: parsed.data.title,
      email: parsed.data.email ?? false,
    });
    return respondIntake(c, out);
  });

  // The Markdown inbox (reading-lite-gh423): staged text awaiting a person's
  // review. Staging writes only the inbox row; see src/inbox/stage.ts.
  // A body that cannot hold an acceptable item is refused before it is
  // parsed: bodyLimit trusts a declared Content-Length and otherwise counts
  // the bytes as it reads them.
  const inboxBodyLimit = bodyLimit({ maxSize: INBOX_BODY_MAX_BYTES, onError: markdownTooLarge });
  app.post("/api/inbox", requireScope("readings:import"), inboxBodyLimit, async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostInboxBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    if (inboxMessageBytes(parsed.data) > INBOX_STAGE_BUDGET_BYTES) return markdownTooLarge(c);
    const principal = c.get("principal");
    const sql = c.get("sql");
    const out = await stageInboxItem(
      {
        inbox: inboxFor(principal, services, sql),
        store: storesFor(c.env, principal, sql).store,
        usage: tenantUsageFor(c.env, String(principal.tenantId)),
        services,
        pendingTtlSeconds: pendingTtlSeconds(c.env),
      },
      { url: parsed.data.source_url, markdown: parsed.data.markdown, title: parsed.data.title },
    );
    return respondInboxStage(c, out);
  });

  app.get("/api/inbox", requireScope("readings:read"), async (c) => {
    const body: ListInboxResponse = { items: await inboxFor(c.get("principal"), services, c.get("sql")).list() };
    return c.json(body);
  });

  app.get("/api/inbox/:id", requireScope("readings:read"), async (c) => {
    const item = await inboxFor(c.get("principal"), services, c.get("sql")).get(c.req.param("id"));
    return item ? c.json(item) : c.json({ error: "not found" }, 404);
  });

  // Promote turns the item into a reading through importMarkdown and deletes
  // it once the corpus has the URL; see src/inbox/promote.ts. The body is
  // optional.
  app.post("/api/inbox/:id/promote", requireScope("readings:import"), async (c) => {
    const text = await c.req.text();
    const parsed = PostInboxPromoteBodySchema.safeParse(text.trim() === "" ? {} : parseJson(text));
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const principal = c.get("principal");
    const sql = c.get("sql");
    const out = await promoteInboxItem(
      { inbox: inboxFor(principal, services, sql), intake: intakeFor(c.env, principal, services, sql) },
      c.req.param("id"),
      { email: parsed.data.email ?? false },
    );
    return respondInboxPromote(c, out);
  });

  app.delete("/api/inbox/:id", requireScope("readings:import"), async (c) => {
    const discarded = await inboxFor(c.get("principal"), services, c.get("sql")).discard(c.req.param("id"));
    return discarded ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  // The desk (reading-lite-kl7y.6): up to DESK_CAP readings set aside to read
  // next. Writes touch only reading_desk, never the reading; see
  // src/modules/stores/postgres/desk-store.ts. GET is the desk page's read.
  app.post("/api/desk", requireScope("readings:write"), async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostDeskBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const out = await deskFor(c.get("principal"), services, c.get("sql")).add(parsed.data.id);
    switch (out.kind) {
      case "desk":
        return c.json(deskBody(out.desk));
      case "not_found":
        return c.json({ error: "not found" }, 404);
      case "not_ready": {
        const body: DeskNotReadyResponse = { error: "only a ready reading can go on the desk", code: "not_ready" };
        return c.json(body, 409);
      }
      case "desk_full": {
        const body: DeskFullResponse = { error: "the desk is full", code: "desk_full", limit: DESK_CAP };
        return c.json(body, 409);
      }
    }
  });

  app.delete("/api/desk/:id", requireScope("readings:write"), async (c) => {
    const out = await deskFor(c.get("principal"), services, c.get("sql")).remove(c.req.param("id"));
    return out.kind === "desk" ? c.json(deskBody(out.desk)) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/desk", requireScope("readings:read"), async (c) => {
    const parsed = GetDeskQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid query", details: parsed.error.message }, 400);
    }
    const desk = deskFor(c.get("principal"), services, c.get("sql"));
    const body: GetDeskResponse = await desk.read({ since: parsed.data.since, ttlSeconds: pendingTtlSeconds(c.env) });
    return c.json(body);
  });

  app.delete("/api/desk", requireScope("readings:write"), async (c) => {
    return c.json(deskBody(await deskFor(c.get("principal"), services, c.get("sql")).clear()));
  });

  app.get("/api/readings", requireScope("readings:read"), async (c) => {
    const parsed = ListReadingsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid query", details: parsed.error.message }, 400);
    }
    const { q, tag, offset, limit } = parsed.data;
    const { store } = storesFor(c.env, c.get("principal"), c.get("sql"));
    const out = await store.listManifests({ q, tag, offset, limit });
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
    // Read-only: a GET must be side-effect-free and cheap. Owner resolution is
    // one SELECT over the URL's unique row — no claims, repairs or scans — and
    // an owner is never half-written, so the URL is either owned or not found.
    const { store } = storesFor(c.env, c.get("principal"), c.get("sql"));
    const owner = await store.findOwnerByUrl(url);
    return owner ? c.json({ id: owner.id }) : c.json({ error: "not found" }, 404);
  });

  // One side-effect-free read of the tenant's whole relationship graph, for
  // the frontend's threads. A fixed segment, registered before /:id.
  app.get("/api/readings/relationships", requireScope("readings:read"), async (c) => {
    const { store } = storesFor(c.env, c.get("principal"), c.get("sql"));
    const body: GetReadingRelationshipsResponse = projectRelationshipGraph(
      await store.relationshipGraph(),
      pendingTtlSeconds(c.env),
      services.now(),
    );
    return c.json(body);
  });

  app.post("/api/readings/similar", requireScope("readings:write"), async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = PostReadingsSimilarBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.message }, 400);
    }
    const similarity = pgSimilarityStoreFor(c.get("sql"), { tenantId: c.get("principal").tenantId });
    const items = await similarity.query(parsed.data.query_embedding, parsed.data.k);
    return c.json({ items });
  });

  app.get("/api/readings/:id/diagnostics", requireScope("readings:read"), async (c) => {
    const id = c.req.param("id");
    const { store, writer, content } = storesFor(c.env, c.get("principal"), c.get("sql"));
    const found = await store.loadReadingById(id);
    if (!found) return c.json({ error: "not found" }, 404);
    const manifest = found.manifest;
    // The response keeps the pointer vocabulary its consumers parse. The by-id
    // "pointer" is the row itself, and the by-url one is the URL's owner row.
    const ptr = { id, key_prefix: found.keyPrefix };
    const owner = await store.findOwnerByUrl(manifest.url);
    const ownerRow = owner && owner.id !== id ? await store.loadReadingById(owner.id) : found;
    const byUrl = owner && ownerRow ? { id: owner.id, key_prefix: ownerRow.keyPrefix } : null;
    const [indexItem = null] = await store.relationshipTargets([id]);
    const objects = await content.list(found.keyPrefix);
    const attempts = await writer.listAttempts(id, 20);
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
    const intake = intakeFor(c.env, c.get("principal"), services, c.get("sql"));
    const out = await intake.reprocess(c.req.param("id"), {
      force: parsed.data.force,
      email: parsed.data.email ?? false,
      source: parsed.data.source,
    });
    return respondIntake(c, out);
  });

  app.delete("/api/readings/:id", requireScope("readings:delete"), async (c) => {
    const id = c.req.param("id");
    const principal = c.get("principal");
    const { writer, content } = storesFor(c.env, principal, c.get("sql"));
    // One-reading purge inside a live tenant. Account deletion is
    // DELETE /api/account (195a) — do not fold that workflow in here.
    const out = await purgeReading({ writer, content }, id, {
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
    const { store } = storesFor(c.env, c.get("principal"), c.get("sql"));
    const found = await store.loadReadingById(id);
    if (!found) return c.json({ error: "not found" }, 404);
    const ttl = pendingTtlSeconds(c.env);
    const now = services.now();
    // Read-time only: one keyed read of the target rows, skipped when there is
    // nothing to resolve. Never written back to the reading.
    const targetIds = relationshipTargetIds(found.manifest);
    const relationship_targets = targetIds.length === 0
      ? {}
      : projectRelationshipTargets(targetIds, await store.relationshipTargets(targetIds), ttl, now);
    const body: GetReadingResponse = {
      ...applyStaleness(found.manifest, ttl, now),
      ...(found.deskPosition === undefined ? {} : { desk_position: found.deskPosition }),
      relationship_targets,
    };
    return c.json(body);
  });

  app.get("/api/readings/:id/content", requireScope("readings:read"), async (c) => {
    const id = c.req.param("id");
    const { store, content } = storesFor(c.env, c.get("principal"), c.get("sql"));
    const found = await store.loadReadingById(id);
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.manifest.content_status !== "captured") {
      return c.json({ error: "extracted markdown not available" }, 404);
    }
    const obj = await readContent(store, content, id, (keys) => keys.extractedKey);
    if (!obj) return c.json({ error: "not found" }, 404);
    return new Response(obj.body, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  });

  app.get("/api/readings/:id/content/raw", requireScope("readings:read"), async (c) => {
    const id = c.req.param("id");
    const { store, content } = storesFor(c.env, c.get("principal"), c.get("sql"));
    const obj = await readContent(store, content, id, (keys) => keys.rawKey);
    if (!obj) return c.json({ error: "not found" }, 404);
    return new Response(obj.body, {
      status: 200,
      headers: { "content-type": obj.contentType },
    });
  });

  return app;
}

// A content read: the row's keys (never a spelling derived from key_prefix; a
// published reading's content is under its revision, an imported one's is
// not), then the object. The two steps are not atomic. A reprocess that
// publishes in between commits new keys and deletes the superseded object
// (AttemptIo.discardSupersededContent), so a key resolved just before that can
// point at nothing. A missing object is therefore resolved once more: the keys
// changed, and the current object is served; or they did not, and the content
// is genuinely gone.
async function readContent(
  store: PgReadingStore,
  content: ContentStore,
  id: string,
  pick: (keys: ContentKeys) => string | null,
): Promise<RawObject | null> {
  const first = await store.contentKeys(id);
  const firstKey = first ? pick(first) : null;
  const obj = firstKey ? await content.get(firstKey) : null;
  if (obj?.body) return obj;
  const again = await store.contentKeys(id);
  const againKey = again ? pick(again) : null;
  if (!againKey || againKey === firstKey) return null;
  const retried = await content.get(againKey);
  return retried?.body ? retried : null;
}

// The 503 bodies the frontend and operator tooling match on — one message per
// retryable `unavailable` reason, byte-identical to the pre-intake router.
const UNAVAILABLE_MESSAGES: Record<
  Extract<IntakeOutcome, { kind: "unavailable" }>["reason"],
  string
> = {
  queue_unbound: "queue binding READING_JOBS is not configured",
  claim_contention: "could not claim url ownership under contention",
  activation_failed: "reading setup failed",
  queue_send_failed: "queue send failed",
};

const QUOTA_MESSAGES: Record<"request_rate" | "hourly" | "monthly", string> = {
  request_rate: "request rate limit exceeded",
  hourly: "hourly reading quota exceeded",
  monthly: "monthly reading quota exceeded",
};

// The single outcome → HTTP mapping. Reading intake is HTTP-free; everything
// status-code- or body-shaped about submit/import/reprocess lives here.
function toHttp(out: IntakeOutcome): {
  body: unknown;
  status: 200 | 202 | 400 | 403 | 404 | 409 | 413 | 429 | 503;
  headers?: Record<string, string>;
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
    case "invalid_url":
      return {
        body: { error: `url rejected: ${out.reason}`, code: "unsupported_url" },
        status: 400,
      };
    case "unavailable":
      return {
        body: {
          error: UNAVAILABLE_MESSAGES[out.reason],
          ...("id" in out && out.id !== undefined ? { id: out.id } : {}),
        },
        status: 503,
      };
    case "rate_limited":
      return quotaHttp("rate_limited", out.limit, out.resetAtMs);
    case "quota_exhausted":
      return quotaHttp("quota_exhausted", out.limit, out.resetAtMs);
    case "guard_unavailable":
      return {
        body: { error: "usage guard unavailable" },
        status: 429,
        headers: { "Retry-After": "5" },
      };
    // Tenant provider keys are on and the named provider's key is not active
    // (ADR 0004, OpenAI first): nothing was claimed. Not retryable until they
    // connect or replace that key.
    case "provider_key_required":
      return {
        body: { error: "connect a key, then retry", code: "provider_key_required", provider: out.provider },
        status: 409,
      };
    // The account was marked deleting after this request authenticated; the
    // claim transaction saw it under the tenant lock and wrote nothing. Same
    // 403 body the authenticated seam gives a tenant that is not active.
    case "tenant_inactive":
      return { body: { error: "forbidden" }, status: 403 };
    // Only inbox promote measures its message (src/inbox/promote.ts), so the
    // budget is the inbox's.
    case "too_large":
      return { body: MARKDOWN_TOO_LARGE, status: 413 };
  }
}

function quotaHttp(
  error: "rate_limited" | "quota_exhausted",
  limit: "request_rate" | "hourly" | "monthly",
  resetAtMs: number,
): {
  body: unknown;
  status: 429;
  headers: Record<string, string>;
} {
  const retryAfter = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
  return {
    body: {
      error: QUOTA_MESSAGES[limit],
      code: error,
      limit,
      reset_at: new Date(resetAtMs).toISOString(),
    },
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  };
}

const MARKDOWN_TOO_LARGE = {
  error: "markdown too large",
  code: "markdown_too_large",
  limit_bytes: INBOX_STAGE_BUDGET_BYTES,
} as const;

function markdownTooLarge(c: Context<AppBindings>): Response {
  return c.json(MARKDOWN_TOO_LARGE, 413);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function respondInboxStage(c: Context<AppBindings>, out: InboxStageOutcome): Response {
  switch (out.kind) {
    case "staged": {
      const body: PostInboxStagedResponse = {
        inbox_item_id: out.item.id,
        replaced: out.replaced,
        ...(out.corpusReading ? { corpus_reading: out.corpusReading } : {}),
      };
      return c.json(body, out.replaced ? 200 : 201);
    }
    case "existing": {
      const body: PostInboxExistingResponse = { existing: true, reading: out.manifest };
      return c.json(body, 200);
    }
    // Not time-based: the inbox frees up only when items are promoted or
    // discarded, so there is no Retry-After.
    case "inbox_full":
      return c.json({ error: "inbox is full", code: "inbox_full", limit: INBOX_ITEM_CAP }, 429);
    case "too_large":
      return markdownTooLarge(c);
    // The same bodies and headers the reading verbs give these outcomes.
    case "rate_limited":
    case "quota_exhausted":
    case "guard_unavailable":
    case "tenant_inactive":
      return respondIntake(c, out);
  }
}

// The body import-markdown gives the same outcome, plus the item promoted.
function respondInboxPromote(c: Context<AppBindings>, out: InboxPromoteOutcome): Response {
  if (out.kind === "not_found") return c.json({ error: "not found" }, 404);
  const mapped = toHttp(out.intake);
  const body = {
    ...(mapped.body as Record<string, unknown>),
    inbox_item_id: out.itemId,
    ...(out.retained ? { inbox_item_retained: true } : {}),
  };
  if (mapped.headers) return c.json(body, mapped.status, mapped.headers);
  return c.json(body, mapped.status);
}

function respondIntake(c: Context<AppBindings>, out: IntakeOutcome): Response {
  const mapped = toHttp(out);
  if (mapped.headers) return c.json(mapped.body, mapped.status, mapped.headers);
  return c.json(mapped.body, mapped.status);
}

function pendingTtlSeconds(env: Env): number {
  return parsePendingTtlSeconds(env.PENDING_TTL_SECONDS);
}
