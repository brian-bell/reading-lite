import type { ControlPlaneDb } from "./db";
import { OPENAI_EMBEDDING_MODEL } from "../modules/embeddings";
import { PAID_PRICE_CATALOG_VERSION } from "../modules/paid-pricing";
import type { ProcessingConfig } from "../modules/processing-checkpoint";
import {
  DEFAULT_OPENAI_SUMMARIZATION_MODEL,
  parseAnthropicEffort,
  parseReasoningEffort,
  parseSummarizerProvider,
} from "../modules/summarizer";
import { readSummarizationSettings, type SummarizationSettings } from "./provider-settings";
import { decryptProviderKey, readProviderKeyRoots } from "./provider-key-crypto";
import {
  PROVIDER_ANTHROPIC,
  PROVIDER_OPENAI,
  markProviderCredentialInvalid,
  readProviderCredential,
  type ProviderName,
} from "./provider-credentials";
import type { PaidAuthorization } from "./paid-dispatch";

export function tenantProviderKeysEnabled(env: { TENANT_PROVIDER_KEYS?: string }): boolean {
  return env.TENANT_PROVIDER_KEYS === "1";
}

export async function providerKeyNeeded(
  env: { TENANT_PROVIDER_KEYS?: string },
  db: ControlPlaneDb,
  tenantId: string,
  providers?: readonly ProviderName[],
): Promise<ProviderName | null> {
  if (!tenantProviderKeysEnabled(env)) return null;
  const needed = providers ?? (
    (await readSummarizationSettings(db, tenantId))?.provider === "anthropic"
      ? [PROVIDER_OPENAI, PROVIDER_ANTHROPIC]
      : [PROVIDER_OPENAI]
  );
  for (const provider of needed) {
    const row = await readProviderCredential(db, tenantId, provider);
    if (row?.status !== "active") return provider;
  }
  return null;
}

export class TenantProviderKeyError extends Error {
  constructor(
    readonly code: "provider_key_required" | "provider_key_undecryptable",
    readonly provider: ProviderName = "openai",
  ) {
    super(code === "provider_key_required"
      ? "connect a key, then retry"
      : "provider key could not be decrypted");
    this.name = code;
  }
}

export async function resolveTenantProviderKey(
  db: ControlPlaneDb,
  env: {
    PROVIDER_KEY_SECRET?: string;
    PROVIDER_KEY_VERSION?: string;
    PROVIDER_KEY_PREVIOUS_SECRET?: string;
    PROVIDER_KEY_PREVIOUS_VERSION?: string;
  },
  tenantId: string,
  provider: ProviderName,
): Promise<{ key: string; credentialVersion: number }> {
  const row = await readProviderCredential(db, tenantId, provider);
  if (!row || row.status !== "active") throw new TenantProviderKeyError("provider_key_required", provider);
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
      provider,
      credential_version: row.credentialVersion,
    }));
    throw new TenantProviderKeyError("provider_key_undecryptable", provider);
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
    resolve: (provider) => resolveTenantProviderKey(db, env, tenantId, provider),
    markInvalid: async (provider, credentialVersion, nowMs) => {
      await markProviderCredentialInvalid(db, { tenantId, credentialVersion, nowMs, provider });
    },
  };
}

/**
 * The deployment's keys for the adapters to send, or none with tenant keys
 * on, when the paid fetch attaches the tenant's key for each request. Which
 * provider runs comes from the attempt's ProcessingConfig, not from here.
 */
export function deploymentProviderKeys(env: {
  TENANT_PROVIDER_KEYS?: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
}): { openaiApiKey?: string; anthropicApiKey?: string } {
  if (tenantProviderKeysEnabled(env)) return {};
  // An unset deployment key is "", which the adapters refuse before dispatch.
  return { openaiApiKey: env.OPENAI_API_KEY ?? "", anthropicApiKey: env.ANTHROPIC_API_KEY ?? "" };
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
 * The configuration an attempt's paid stages and the judges run under (ADR
 * 0004). With tenant keys on, the reader's provider at the reader's effort,
 * on that provider's one fixed model; otherwise the deployment's provider,
 * model and effort. It names no key: which key pays does not change the
 * outputs.
 */
export function processingConfigFor(env: ProcessingConfigEnv, tenant?: SummarizationSettings): ProcessingConfig {
  const tenantKeys = tenantProviderKeysEnabled(env);
  const provider = tenantKeys ? tenant?.provider ?? "openai" : parseSummarizerProvider(env.SUMMARIZER_PROVIDER);
  const common = { embedding_model: OPENAI_EMBEDDING_MODEL, catalog_version: PAID_PRICE_CATALOG_VERSION };
  if (provider === "anthropic") {
    return {
      provider,
      summarization_model: env.ANTHROPIC_MODEL,
      effort: parseAnthropicEffort(tenantKeys ? tenant?.effort : env.ANTHROPIC_SUMMARIZATION_REASONING_EFFORT, env.ANTHROPIC_MODEL),
      ...common,
    };
  }
  return {
    provider,
    summarization_model: env.OPENAI_SUMMARIZATION_MODEL ?? DEFAULT_OPENAI_SUMMARIZATION_MODEL,
    effort: parseReasoningEffort(tenantKeys ? tenant?.effort : env.OPENAI_SUMMARIZATION_REASONING_EFFORT),
    ...common,
  };
}

/** The summarizer and judge deps that run `config`'s provider, model and effort. */
export function summarizerSelectionFor(config: ProcessingConfig): {
  provider: ProcessingConfig["provider"];
  openaiModel?: string;
  openaiReasoningEffort?: string;
  anthropicModel?: string;
  anthropicReasoningEffort?: string;
} {
  return config.provider === "anthropic"
    ? { provider: "anthropic", anthropicModel: config.summarization_model, anthropicReasoningEffort: config.effort }
    : { provider: "openai", openaiModel: config.summarization_model, openaiReasoningEffort: config.effort };
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
  return processingConfigFor(env, settings);
}
