import type { Context } from "hono";
import { OPENAI_EMBEDDING_MODEL } from "../modules/embeddings";
import { DEFAULT_OPENAI_SUMMARIZATION_MODEL } from "../modules/summarizer";
import {
  PostProviderKeyBodySchema,
  PostProviderPreferencesBodySchema,
  ProviderUsageResponseSchema,
  type ProviderSettingsError,
} from "../schemas/api";
import type { AppBindings } from "../middleware";
import { jsonAuth } from "./auth-handlers";
import { fromSql } from "./db";
import { checkAnthropicProviderKey, checkOpenAIProviderKey, type ProviderKeyRejection } from "./provider-key-check";
import {
  deleteProviderCredential,
  PROVIDER_ANTHROPIC,
  PROVIDER_OPENAI,
  upsertProviderCredential,
  type ProviderName,
} from "./provider-credentials";
import { readProviderKeyRoots, type ProviderKeyRoot } from "./provider-key-crypto";
import { loadProviderSettings, loadSpendCaps, updateProviderPreferences, type ProviderSettingsLoad } from "./provider-settings";
import { fetchTenantSpendStatus } from "./spend-status";

const KEY_REJECTION: Record<ProviderKeyRejection, { error: string; status: number }> = {
  invalid_key: { error: "invalid key", status: 400 },
  model_access: { error: "model access", status: 400 },
  provider_unavailable: { error: "provider unavailable", status: 503 },
};

function settingsResponse(result: ProviderSettingsLoad): Response {
  if (result === "not_found") return jsonAuth({ error: "not found" }, 404);
  if (result === "limits_missing") return jsonAuth({ error: "internal" }, 500);
  return jsonAuth(result, 200);
}

function keyRejection(code: ProviderKeyRejection): Response {
  const rejection = KEY_REJECTION[code];
  const body: ProviderSettingsError = { error: rejection.error, code };
  return jsonAuth(body, rejection.status);
}

async function storeValidatedProviderKey(
  c: Context<AppBindings>,
  nowMs: number,
  provider: ProviderName,
  plaintext: string,
  root: ProviderKeyRoot,
): Promise<Response> {
  const userId = String(c.get("principal").userId);
  const db = fromSql(c.get("sql"));
  const stored = await upsertProviderCredential(db, {
    tenantId: userId,
    plaintext,
    root,
    nowMs,
    validatedAtMs: nowMs,
    provider,
  });
  if (stored.kind === "inactive") return jsonAuth({ error: "forbidden" }, 403);
  return settingsResponse(await loadProviderSettings(db, userId));
}

function summarizationModel(env: AppBindings["Bindings"]): string {
  const configured = env.OPENAI_SUMMARIZATION_MODEL?.trim();
  return configured ? configured : DEFAULT_OPENAI_SUMMARIZATION_MODEL;
}

export async function handleGetProviderSettings(c: Context<AppBindings>): Promise<Response> {
  const userId = String(c.get("principal").userId);
  return settingsResponse(await loadProviderSettings(fromSql(c.get("sql")), userId));
}

/**
 * Read-only: today's charges against the reader's effective cap. The caps come
 * from PostgreSQL and the charges from the spend guard, so the two are separate
 * observations; the guard's clock picks the day and its reset.
 */
export async function handleGetProviderUsage(c: Context<AppBindings>): Promise<Response> {
  const userId = String(c.get("principal").userId);
  const caps = await loadSpendCaps(fromSql(c.get("sql")), userId);
  if (caps === "not_found") return jsonAuth({ error: "not found" }, 404);
  if (caps === "limits_missing") return jsonAuth({ error: "internal" }, 500);
  const status = await fetchTenantSpendStatus(c.env.GLOBAL_USAGE_GUARD, userId);
  if (!status) return jsonAuth({ error: "usage unavailable" }, 503);
  return jsonAuth(ProviderUsageResponseSchema.parse({
    day_key: status.dayKey,
    charged_microdollars: status.tenantChargedMicrodollars,
    effective_daily_spend_microdollars: caps.effective_daily_spend_microdollars,
    reset_at_ms: status.resetAtMs,
    observed_at_ms: status.observedAtMs,
  }), 200);
}

export async function handleConnectProviderKey(
  c: Context<AppBindings>,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const json: unknown = await c.req.json().catch(() => null);
  const parsed = PostProviderKeyBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  let roots;
  try {
    roots = readProviderKeyRoots(c.env);
  } catch {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const check = await checkOpenAIProviderKey({
    fetch: fetchImpl,
    apiKey: parsed.data.api_key,
    summarizationModel: summarizationModel(c.env),
    embeddingModel: OPENAI_EMBEDDING_MODEL,
  });
  if (!check.ok) return keyRejection(check.code);

  return storeValidatedProviderKey(c, nowMs, PROVIDER_OPENAI, parsed.data.api_key, roots.providerKeyRoot);
}

export async function handleDeleteProviderKey(c: Context<AppBindings>): Promise<Response> {
  const userId = String(c.get("principal").userId);
  const db = fromSql(c.get("sql"));
  await deleteProviderCredential(db, { tenantId: userId, provider: PROVIDER_OPENAI });
  return settingsResponse(await loadProviderSettings(db, userId));
}

export async function handleConnectAnthropicKey(
  c: Context<AppBindings>,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const json: unknown = await c.req.json().catch(() => null);
  const parsed = PostProviderKeyBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  let roots;
  try {
    roots = readProviderKeyRoots(c.env);
  } catch {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const check = await checkAnthropicProviderKey({
    fetch: fetchImpl,
    apiKey: parsed.data.api_key,
    model: c.env.ANTHROPIC_MODEL.trim(),
  });
  if (!check.ok) return keyRejection(check.code);

  return storeValidatedProviderKey(c, nowMs, PROVIDER_ANTHROPIC, parsed.data.api_key, roots.providerKeyRoot);
}

export async function handleDeleteAnthropicKey(c: Context<AppBindings>): Promise<Response> {
  const userId = String(c.get("principal").userId);
  const db = fromSql(c.get("sql"));
  await deleteProviderCredential(db, { tenantId: userId, provider: PROVIDER_ANTHROPIC });
  return settingsResponse(await loadProviderSettings(db, userId));
}

export async function handleUpdateProviderPreferences(c: Context<AppBindings>, nowMs: number): Promise<Response> {
  const json: unknown = await c.req.json().catch(() => null);
  const parsed = PostProviderPreferencesBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  const userId = String(c.get("principal").userId);
  const db = fromSql(c.get("sql"));
  const updated = await updateProviderPreferences(db, {
    userId,
    nowMs,
    ...(parsed.data.effort !== undefined ? { effort: parsed.data.effort } : {}),
    ...(parsed.data.daily_spend_cap_microdollars !== undefined
      ? { dailySpendCapMicrodollars: parsed.data.daily_spend_cap_microdollars }
      : {}),
    ...(parsed.data.summarization_provider !== undefined
      ? { summarizationProvider: parsed.data.summarization_provider }
      : {}),
  });
  if (updated === "cap_above_operator_default") {
    return jsonAuth({ error: "cap above operator default", code: "cap_above_operator_default" }, 400);
  }
  if (updated === "anthropic_key_required") {
    const body: ProviderSettingsError = { error: "anthropic key required", code: "anthropic_key_required" };
    return jsonAuth(body, 400);
  }
  if (updated === "not_found") return jsonAuth({ error: "not found" }, 404);
  if (updated === "limits_missing") return jsonAuth({ error: "internal" }, 500);
  return settingsResponse(await loadProviderSettings(db, userId));
}
