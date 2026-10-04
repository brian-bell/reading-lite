import type { ControlPlaneDb } from "./db";
import type { SummarizationEffort } from "../schemas/api";
import { OPENAI_EMBEDDING_MODEL } from "../modules/embeddings";
import { PAID_PRICE_CATALOG_VERSION } from "../modules/paid-pricing";
import type { ProcessingConfig } from "../modules/processing-checkpoint";
import {
  DEFAULT_OPENAI_SUMMARIZATION_MODEL,
  parseAnthropicEffort,
  parseReasoningEffort,
  parseSummarizerProvider,
} from "../modules/summarizer";
import { readSummarizationSettings } from "./provider-settings";
import { decryptProviderKey, readProviderKeyRoots } from "./provider-key-crypto";
import { markProviderCredentialInvalid, readProviderCredential } from "./provider-credentials";
import type { PaidAuthorization } from "./paid-dispatch";

export function tenantProviderKeysEnabled(env: { TENANT_PROVIDER_KEYS?: string }): boolean {
  return env.TENANT_PROVIDER_KEYS === "1";
}

/**
 * Whether this tenant's reading work can reach a provider: always with tenant
 * keys off, since the deployment pays; with them on, only while the tenant
 * holds an active key. Intake asks before it claims anything, so a reader with
 * no key is told to connect one rather than handed a reading that fails at its
 * first paid stage. Dispatch still resolves the key for itself, because a key
 * can be removed after intake admitted the work.
 */
export async function providerKeyReady(
  env: { TENANT_PROVIDER_KEYS?: string },
  db: ControlPlaneDb,
  tenantId: string,
): Promise<boolean> {
  if (!tenantProviderKeysEnabled(env)) return true;
  const row = await readProviderCredential(db, tenantId);
  return row?.status === "active";
}

export class TenantProviderKeyError extends Error {
  constructor(readonly code: "provider_key_required" | "provider_key_undecryptable") {
    super(code === "provider_key_required"
      ? "connect a key, then retry"
      : "provider key could not be decrypted");
    this.name = code;
  }
}

export async function resolveTenantOpenAIKey(
  db: ControlPlaneDb,
  env: {
    PROVIDER_KEY_SECRET?: string;
    PROVIDER_KEY_VERSION?: string;
    PROVIDER_KEY_PREVIOUS_SECRET?: string;
    PROVIDER_KEY_PREVIOUS_VERSION?: string;
  },
  tenantId: string,
): Promise<{ key: string; credentialVersion: number }> {
  const row = await readProviderCredential(db, tenantId);
  if (!row || row.status !== "active") throw new TenantProviderKeyError("provider_key_required");
  try {
    const key = await decryptProviderKey({
      roots: readProviderKeyRoots(env),
      tenantId: row.tenantId,
      credentialVersion: row.credentialVersion,
      keyVersion: row.keyVersion,
      ciphertext: row.ciphertext,
      iv: row.iv,
    });
    return { key, credentialVersion: row.credentialVersion };
  } catch (error) {
    if (error instanceof TenantProviderKeyError) throw error;
    console.error(JSON.stringify({
      event: "provider_key_undecryptable",
      tenant_id: tenantId,
      credential_version: row.credentialVersion,
    }));
    throw new TenantProviderKeyError("provider_key_undecryptable");
  }
}

export function paidAuthorizationFor(
  env: {
    TENANT_PROVIDER_KEYS?: string;
    PROVIDER_KEY_SECRET?: string;
    PROVIDER_KEY_VERSION?: string;
    PROVIDER_KEY_PREVIOUS_SECRET?: string;
    PROVIDER_KEY_PREVIOUS_VERSION?: string;
  },
  db: ControlPlaneDb,
  tenantId: string,
): PaidAuthorization {
  if (!tenantProviderKeysEnabled(env)) return { mode: "deployment" };
  return {
    mode: "tenant",
    resolve: () => resolveTenantOpenAIKey(db, env, tenantId),
    markInvalid: async (credentialVersion, nowMs) => {
      await markProviderCredentialInvalid(db, { tenantId, credentialVersion, nowMs });
    },
  };
}

export function hostedProviderSelection(env: {
  TENANT_PROVIDER_KEYS?: string;
  SUMMARIZER_PROVIDER?: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
}): { provider?: string; openaiApiKey?: string; anthropicApiKey?: string } {
  if (tenantProviderKeysEnabled(env)) return { provider: "openai" };
  return {
    provider: env.SUMMARIZER_PROVIDER,
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  };
}

type ProcessingConfigEnv = {
  TENANT_PROVIDER_KEYS?: string;
  SUMMARIZER_PROVIDER?: string;
  OPENAI_SUMMARIZATION_MODEL?: string;
  OPENAI_SUMMARIZATION_REASONING_EFFORT?: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_SUMMARIZATION_REASONING_EFFORT?: string;
};

/**
 * The configuration an attempt's paid stages run under (ADR 0004). With tenant
 * keys on, summaries use OpenAI at the reader's effort; otherwise the
 * deployment's provider, model and effort. It names no key: which key pays
 * does not change the outputs.
 */
export function processingConfigFor(env: ProcessingConfigEnv, tenantEffort?: SummarizationEffort): ProcessingConfig {
  const tenantKeys = tenantProviderKeysEnabled(env);
  const provider = tenantKeys ? "openai" : parseSummarizerProvider(env.SUMMARIZER_PROVIDER);
  const common = { embedding_model: OPENAI_EMBEDDING_MODEL, catalog_version: PAID_PRICE_CATALOG_VERSION };
  if (provider === "anthropic") {
    return {
      provider,
      summarization_model: env.ANTHROPIC_MODEL,
      effort: parseAnthropicEffort(env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT, env.ANTHROPIC_MODEL),
      ...common,
    };
  }
  return {
    provider,
    summarization_model: env.OPENAI_SUMMARIZATION_MODEL ?? DEFAULT_OPENAI_SUMMARIZATION_MODEL,
    effort: parseReasoningEffort(tenantKeys ? tenantEffort : env.OPENAI_SUMMARIZATION_REASONING_EFFORT),
    ...common,
  };
}

export async function resolveProcessingConfig(
  env: ProcessingConfigEnv,
  db: ControlPlaneDb,
  tenantId: string,
): Promise<ProcessingConfig> {
  if (!tenantProviderKeysEnabled(env)) return processingConfigFor(env);
  // Fail closed: a reader without a settings row has no effort to run at.
  const settings = await readSummarizationSettings(db, tenantId);
  if (settings === null) throw new Error("tenant has no summarization effort setting");
  return processingConfigFor(env, settings.effort);
}
