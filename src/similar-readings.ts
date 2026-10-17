// Meaning search and More like this (reading-lite-kl7y.5): which of the
// reader's readings are close to a question they typed (paid, one embedding of
// the question) or to the reading on screen (free, its stored vector). This
// module owns the result sizes, the floor, More like this's exclusion of judged
// targets, the OpenAI key gate, the paid wiring, and the refusal-to-HTTP
// table. The router only registers the two handlers.
//
// A search is not a save, so it takes no reading slot and no request-rate
// admission; the daily spend cap and the processing lease still apply
// (docs/paid-provider-spend.md).

import type { Context } from "hono";
import type { AppBindings } from "./middleware";
import type { Services } from "./services";
import { fromSql } from "./control-plane/db";
import {
  createPaidFetch,
  ProviderAccountError,
  SpendAdmissionError,
  spendRpcFor,
  type ProviderAccountErrorCode,
} from "./control-plane/paid-dispatch";
import {
  acquireProcessingLeases,
  DeferPaidWorkError,
  presentLeaseBeforePaidDispatch,
  releaseProcessingLeases,
  StaleProcessingLeaseError,
} from "./control-plane/processing-leases";
import { PROVIDER_OPENAI, type ProviderName } from "./control-plane/provider-credentials";
import {
  paidAuthorizationFor,
  providerKeyNeeded,
  tenantProviderKeysEnabled,
  TenantProviderKeyError,
} from "./control-plane/tenant-provider-keys";
import { BadEmbeddingResponseError, embed, OpenAIError } from "./modules/embeddings";
import { RateLimitedError, retryDepsFromEnv } from "./modules/http-retry";
import { relationshipTargetIds } from "./modules/relationship-targets";
import { pgReadingStoreFor } from "./modules/stores/postgres/reading-store";
import { pgSimilarityStoreFor } from "./modules/stores/postgres/similarity-store";
import { aboveFloor, SIMILAR_TOP_K, SIMILARITY_FLOOR } from "./modules/stores/similarity";
import { PostReadingsSearchBodySchema, type PostReadingsSimilarResponse } from "./schemas/api";

type AppContext = Context<AppBindings>;

/** Rows a question is compared against before the floor. */
const MEANING_SEARCH_TOP_K = 10;

type AccountCode = Exclude<ProviderAccountErrorCode, "hosted_provider_quota"> | "provider_key_undecryptable";

type Refusal =
  | { kind: "key_required"; provider: ProviderName }
  | { kind: "account"; code: AccountCode; message: string }
  | { kind: "limit"; code: "SpendAdmissionError" | "hosted_provider_quota" | "DeferPaidWorkError"; message: string }
  | { kind: "unavailable" };

const LEASE_REFUSAL: Refusal = {
  kind: "limit",
  code: "DeferPaidWorkError",
  message: "processing limit reached; retry later",
};

/** POST /api/readings/search. The key gate and the lease both decide before any reservation. */
export async function handleMeaningSearch(c: AppContext, services: Services): Promise<Response> {
  const json = await c.req.json().catch(() => null);
  const parsed = PostReadingsSearchBodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.message }, 400);
  }
  const env = c.env;
  const principal = c.get("principal");
  const tenantId = String(principal.tenantId);
  const sql = c.get("sql");
  const db = fromSql(sql);
  const needed = await providerKeyNeeded(env, db, tenantId, [PROVIDER_OPENAI]);
  if (needed) return respond(c, { kind: "key_required", provider: needed });

  const clock = () => nowMs(services);
  // Not services.newId, which mints reading ids: the lease and every
  // dispatch's operation id name this search, not a reading.
  const attemptId = `search:${crypto.randomUUID()}`;
  const acquired = await acquireProcessingLeases(env, tenantId, attemptId, clock());
  if (!acquired.ok || acquired.alreadyRunning) return respond(c, LEASE_REFUSAL);
  const hold = acquired.hold;

  let embedding: number[];
  try {
    ({ embedding } = await embed(parsed.data.query, {
      fetch: createPaidFetch({
        tenantId,
        attemptId,
        stage: "embed_query",
        fetch: services.fetch,
        // Spend admission uses wall time even when the request clock is injected.
        rpc: spendRpcFor(env),
        now: Date.now,
        authorization: paidAuthorizationFor(env, db, tenantId),
        beforeDispatch: () => presentLeaseBeforePaidDispatch(env, hold, clock),
      }),
      ...(tenantProviderKeysEnabled(env) ? {} : { apiKey: env.OPENAI_API_KEY }),
      retry: retryDepsFromEnv(env),
    }));
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) throw error;
    return respond(c, refusal);
  } finally {
    await releaseProcessingLeases(env, hold, clock());
  }

  const matches = await pgSimilarityStoreFor(sql, { tenantId: principal.tenantId }).query(embedding, MEANING_SEARCH_TOP_K);
  const body: PostReadingsSimilarResponse = { items: aboveFloor(matches, SIMILARITY_FLOOR) };
  return c.json(body);
}

/** GET /api/readings/:id/similar. Free: the reading's stored vector, no provider call. */
export async function handleSimilarReadings(c: AppContext): Promise<Response> {
  const id = c.req.param("id") ?? "";
  const tenant = { tenantId: c.get("principal").tenantId };
  const sql = c.get("sql");
  const found = await pgReadingStoreFor(sql, tenant).loadReadingById(id);
  if (!found) return c.json({ error: "not found" }, 404);
  // A judged connection or tension is already beside the reading; repeating
  // it here would say the same thing with less.
  const exclude = [id, ...relationshipTargetIds(found.manifest)];
  const matches = await pgSimilarityStoreFor(sql, tenant).queryByVectorId(id, SIMILAR_TOP_K, exclude);
  const body: PostReadingsSimilarResponse = { items: matches === null ? [] : aboveFloor(matches, SIMILARITY_FLOOR) };
  return c.json(body);
}

/** What a thrown error means for the reader, or null to leave it to onError as a 500. */
function refusalOf(error: unknown): Refusal | null {
  if (error instanceof TenantProviderKeyError) {
    // Required here means the key went away between the gate and dispatch.
    return error.code === "provider_key_required"
      ? { kind: "key_required", provider: error.provider }
      : { kind: "account", code: error.code, message: error.message };
  }
  if (error instanceof ProviderAccountError) {
    return error.code === "hosted_provider_quota"
      ? { kind: "limit", code: error.code, message: error.message }
      : { kind: "account", code: error.code, message: error.message };
  }
  // SpendAdmissionError is a DeferPaidWorkError, so it is matched first.
  if (error instanceof SpendAdmissionError) return { kind: "limit", code: "SpendAdmissionError", message: error.message };
  if (error instanceof DeferPaidWorkError || error instanceof StaleProcessingLeaseError) return LEASE_REFUSAL;
  // fetch rejects with a TypeError when the request got no response at all.
  if (
    error instanceof RateLimitedError ||
    error instanceof OpenAIError ||
    error instanceof BadEmbeddingResponseError ||
    error instanceof TypeError
  ) {
    return { kind: "unavailable" };
  }
  return null;
}

// 409 is the reader's own account to change, 429 a limit to wait out, 503 a
// provider that did not answer. Never 401 or 403: the frontend reads those as
// the session ending and the request itself being refused.
function respond(c: AppContext, refusal: Refusal): Response {
  switch (refusal.kind) {
    case "key_required":
      return c.json(
        { error: "connect a key, then retry", code: "provider_key_required", provider: refusal.provider },
        409,
      );
    case "account":
      return c.json({ error: refusal.message, code: refusal.code }, 409);
    case "limit":
      return c.json({ error: refusal.message, code: refusal.code }, 429);
    case "unavailable":
      return c.json({ error: "meaning search unavailable; retry" }, 503);
  }
}

function nowMs(services: Services): number {
  const parsed = Date.parse(services.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}
