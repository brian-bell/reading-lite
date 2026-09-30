import type { ControlPlaneDb } from "./db";
import { decryptProviderKey, readProviderKeyRoots } from "./provider-key-crypto";
import { markProviderCredentialInvalid, readProviderCredential } from "./provider-credentials";
import type { PaidAuthorization } from "./paid-dispatch";

export function tenantProviderKeysEnabled(env: { TENANT_PROVIDER_KEYS?: string }): boolean {
  return env.TENANT_PROVIDER_KEYS === "1";
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
