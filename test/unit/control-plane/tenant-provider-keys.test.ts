import { describe, expect, it, vi } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret, parseProviderKeySecret } from "../../../src/control-plane/crypto";
import {
  markProviderCredentialInvalid,
  upsertProviderCredential,
} from "../../../src/control-plane/provider-credentials";
import {
  resolveTenantOpenAIKey,
  TenantProviderKeyError,
} from "../../../src/control-plane/tenant-provider-keys";
import { useControlPlane } from "../../helpers/control-plane-pg";

const openControlPlane = useControlPlane();
const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER_SECRET = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const NOW_MS = Date.parse("2026-09-28T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const OTHER = "usr_11111111-1111-4111-8111-111111111111";
const KEY = "sk-tenant-resolver-4242";

async function seeded() {
  const { db } = openControlPlane();
  await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => USER,
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return db;
}

describe("resolveTenantOpenAIKey", () => {
  it("returns the active key and fails closed for a missing, invalid, or other tenant", async () => {
    const db = await seeded();
    const env = { PROVIDER_KEY_SECRET: SECRET };
    await expect(resolveTenantOpenAIKey(db, env, USER)).rejects.toMatchObject({
      name: "provider_key_required",
      message: "connect a key, then retry",
    });
    const stored = await upsertProviderCredential(db, {
      tenantId: USER,
      plaintext: KEY,
      root: { secret: parseProviderKeySecret(SECRET), version: 1 },
      nowMs: NOW_MS,
      validatedAtMs: NOW_MS,
    });
    expect(await resolveTenantOpenAIKey(db, env, USER)).toEqual({ key: KEY, credentialVersion: stored.credentialVersion });
    await expect(resolveTenantOpenAIKey(db, env, OTHER)).rejects.toBeInstanceOf(TenantProviderKeyError);
    await markProviderCredentialInvalid(db, {
      tenantId: USER,
      credentialVersion: stored.credentialVersion,
      nowMs: NOW_MS + 1,
    });
    await expect(resolveTenantOpenAIKey(db, env, USER)).rejects.toMatchObject({ name: "provider_key_required" });
  });

  it("logs an operator event without the plaintext when the ciphertext will not open", async () => {
    const db = await seeded();
    await upsertProviderCredential(db, {
      tenantId: USER,
      plaintext: KEY,
      root: { secret: parseProviderKeySecret(SECRET), version: 1 },
      nowMs: NOW_MS,
      validatedAtMs: NOW_MS,
    });
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    await expect(resolveTenantOpenAIKey(db, {
      PROVIDER_KEY_SECRET: OTHER_SECRET,
      PROVIDER_KEY_VERSION: "2",
    }, USER)).rejects.toMatchObject({
      name: "provider_key_undecryptable",
      message: "provider key could not be decrypted",
    });
    expect(logged.join("\n")).toContain("provider_key_undecryptable");
    expect(logged.join("\n")).not.toContain(KEY);
  });
});
