import { z } from "zod";
import { lockKey, type ControlPlaneDb } from "./db";
import { parseUserId } from "./ids";
import { fromTimestamp, toTimestamp } from "./pg-time";
import {
  encryptProviderKey,
  type ProviderKeyRoot,
} from "./provider-key-crypto";

export const PROVIDER_OPENAI = "openai" as const;
export type ProviderName = typeof PROVIDER_OPENAI;

const Bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array);

const CredentialRowSchema = z.object({
  tenant_id: z.string(),
  provider: z.literal(PROVIDER_OPENAI),
  ciphertext: Bytes,
  iv: Bytes,
  key_version: z.number().int().nonnegative(),
  credential_version: z.number().int().positive(),
  last_four: z.string().length(4),
  status: z.enum(["active", "invalid"]),
  validated_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface ProviderCredential {
  tenantId: string;
  provider: ProviderName;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  keyVersion: number;
  credentialVersion: number;
  lastFour: string;
  status: "active" | "invalid";
  validatedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

const COLUMNS = `tenant_id, provider, ciphertext, iv, key_version, credential_version,
  last_four, status, validated_at, created_at, updated_at`;

export async function readProviderCredential(
  db: ControlPlaneDb,
  tenantId: string,
  provider: ProviderName = PROVIDER_OPENAI,
): Promise<ProviderCredential | null> {
  const id = requireTenant(tenantId);
  const row = await db.first(
    `SELECT ${COLUMNS} FROM tenant_provider_credentials WHERE tenant_id = ? AND provider = ?`,
    id,
    provider,
  );
  return row ? toCredential(row) : null;
}

export async function upsertProviderCredential(
  db: ControlPlaneDb,
  input: {
    tenantId: string;
    plaintext: string;
    root: ProviderKeyRoot;
    nowMs: number;
    validatedAtMs: number | null;
    provider?: ProviderName;
  },
): Promise<ProviderCredential> {
  const tenantId = requireTenant(input.tenantId);
  const provider = input.provider ?? PROVIDER_OPENAI;
  if (input.plaintext.length < 4) throw new Error("provider key must include its last four characters");
  const lastFour = input.plaintext.slice(-4);
  const now = toTimestamp(input.nowMs);
  const validatedAt = toTimestamp(input.validatedAtMs);

  return db.transaction(async (tx) => {
    // The first insert has no row to lock. The advisory lock covers that race,
    // and FOR UPDATE covers a replace of a row that already exists.
    await lockKey(tx, `provider_credential:${tenantId}:${provider}`);
    const current = await tx.first<{ credential_version: number }>(
      `SELECT credential_version FROM tenant_provider_credentials
       WHERE tenant_id = ? AND provider = ?
       FOR UPDATE`,
      tenantId,
      provider,
    );
    const credentialVersion = (current?.credential_version ?? 0) + 1;
    const sealed = await encryptProviderKey({
      root: input.root,
      tenantId,
      credentialVersion,
      plaintext: input.plaintext,
    });
    if (current) {
      await tx.run(
        `UPDATE tenant_provider_credentials
         SET ciphertext = ?, iv = ?, key_version = ?, credential_version = ?,
             last_four = ?, status = 'active', validated_at = ?, updated_at = ?
         WHERE tenant_id = ? AND provider = ?`,
        sealed.ciphertext,
        sealed.iv,
        input.root.version,
        credentialVersion,
        lastFour,
        validatedAt,
        now,
        tenantId,
        provider,
      );
    } else {
      await tx.run(
        `INSERT INTO tenant_provider_credentials (
           tenant_id, provider, ciphertext, iv, key_version, credential_version,
           last_four, status, validated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        tenantId,
        provider,
        sealed.ciphertext,
        sealed.iv,
        input.root.version,
        credentialVersion,
        lastFour,
        validatedAt,
        now,
        now,
      );
    }
    const stored = await readProviderCredential(tx, tenantId, provider);
    if (!stored || stored.credentialVersion !== credentialVersion) {
      throw new Error("provider credential was not stored");
    }
    return stored;
  });
}

export async function deleteProviderCredentials(db: ControlPlaneDb, tenantId: string): Promise<void> {
  const id = requireTenant(tenantId);
  await db.run("DELETE FROM tenant_provider_credentials WHERE tenant_id = ?", id);
}

export async function markProviderCredentialInvalid(
  db: ControlPlaneDb,
  input: { tenantId: string; credentialVersion: number; nowMs: number; provider?: ProviderName },
): Promise<boolean> {
  const tenantId = requireTenant(input.tenantId);
  const provider = input.provider ?? PROVIDER_OPENAI;
  const updated = await db.run(
    `UPDATE tenant_provider_credentials
     SET status = 'invalid', updated_at = ?
     WHERE tenant_id = ? AND provider = ? AND credential_version = ?`,
    toTimestamp(input.nowMs),
    tenantId,
    provider,
    input.credentialVersion,
  );
  return updated.changes === 1;
}

function requireTenant(raw: string): string {
  const id = parseUserId(raw);
  if (!id) throw new Error("tenant id is invalid");
  return id;
}

function toCredential(row: unknown): ProviderCredential {
  const parsed = CredentialRowSchema.parse(row);
  return {
    tenantId: parsed.tenant_id,
    provider: parsed.provider,
    ciphertext: new Uint8Array(parsed.ciphertext),
    iv: new Uint8Array(parsed.iv),
    keyVersion: parsed.key_version,
    credentialVersion: parsed.credential_version,
    lastFour: parsed.last_four,
    status: parsed.status,
    validatedAtMs: fromTimestamp(parsed.validated_at),
    createdAtMs: fromTimestamp(parsed.created_at),
    updatedAtMs: fromTimestamp(parsed.updated_at),
  };
}
