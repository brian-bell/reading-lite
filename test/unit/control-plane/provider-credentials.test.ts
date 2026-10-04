import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret, parseProviderKeySecret } from "../../../src/control-plane/crypto";
import {
  decryptProviderKey,
  encryptProviderKey,
  readProviderKeyRoots,
  type ProviderKeyRoot,
} from "../../../src/control-plane/provider-key-crypto";
import {
  deleteProviderCredential,
  markProviderCredentialInvalid,
  readProviderCredential,
  upsertProviderCredential,
} from "../../../src/control-plane/provider-credentials";
import { useControlPlane } from "../../helpers/control-plane-pg";

const openControlPlane = useControlPlane();

const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PREVIOUS_HEX = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const CURRENT_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const NOW_MS = Date.parse("2026-09-28T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";
const OTHER = "usr_11111111-1111-4111-8111-111111111111";
const KEY = "sk-test-key-1234";
const REPLACED = "sk-replaced-5678";

const root = (secret: string, version: number): ProviderKeyRoot => ({
  secret: parseProviderKeySecret(secret),
  version,
});

async function seeded() {
  const { raw, db } = openControlPlane();
  await bootstrapFounder(db, {
    email: "founder@example.com",
    legacyToken: "test-token",
    signupMode: "open",
    nowMs: NOW_MS,
    authRoot: { secret: parseAuthRootSecret(ROOT_HEX), version: 1 },
    newUserId: () => USER,
    newTokenId: () => "tok_550e8400-e29b-41d4-a716-446655440000",
  });
  return { raw, db };
}

describe("provider key crypto", () => {
  it("round-trips a key and rejects a copy under another tenant or credential version", async () => {
    const providerKeyRoot = root(ROOT_HEX, 1);
    const sealed = await encryptProviderKey({
      root: providerKeyRoot,
      tenantId: USER,
      credentialVersion: 1,
      plaintext: KEY,
    });
    const roots = { providerKeyRoot };
    expect(sealed.iv.byteLength).toBe(12);
    expect(
      await decryptProviderKey({
        roots,
        tenantId: USER,
        credentialVersion: 1,
        keyVersion: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
      }),
    ).toBe("sk-test-key-1234");

    await expect(
      decryptProviderKey({
        roots,
        tenantId: OTHER,
        credentialVersion: 1,
        keyVersion: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
      }),
    ).rejects.toThrow("provider key ciphertext failed to decrypt");
    await expect(
      decryptProviderKey({
        roots,
        tenantId: USER,
        credentialVersion: 2,
        keyVersion: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
      }),
    ).rejects.toThrow("provider key ciphertext failed to decrypt");
  });

  it("decrypts with the previous secret during a versioned rotation and a same-version rotation", async () => {
    const previous = root(PREVIOUS_HEX, 1);
    const current = root(CURRENT_HEX, 2);
    const sealed = await encryptProviderKey({
      root: previous,
      tenantId: USER,
      credentialVersion: 4,
      plaintext: KEY,
    });
    expect(
      await decryptProviderKey({
        roots: { providerKeyRoot: current, previousProviderKeyRoot: previous },
        tenantId: USER,
        credentialVersion: 4,
        keyVersion: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
      }),
    ).toBe("sk-test-key-1234");
    await expect(
      decryptProviderKey({
        roots: { providerKeyRoot: current },
        tenantId: USER,
        credentialVersion: 4,
        keyVersion: 1,
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
      }),
    ).rejects.toThrow("provider key ciphertext failed to decrypt");

    const sameVersionPrevious = root(PREVIOUS_HEX, 1);
    const sameVersionCurrent = root(CURRENT_HEX, 1);
    const rotated = await encryptProviderKey({
      root: sameVersionPrevious,
      tenantId: USER,
      credentialVersion: 4,
      plaintext: REPLACED,
    });
    expect(
      await decryptProviderKey({
        roots: { providerKeyRoot: sameVersionCurrent, previousProviderKeyRoot: sameVersionPrevious },
        tenantId: USER,
        credentialVersion: 4,
        keyVersion: 1,
        ciphertext: rotated.ciphertext,
        iv: rotated.iv,
      }),
    ).toBe("sk-replaced-5678");
  });

  it("reads the current and previous roots and rejects a short secret", () => {
    expect(
      readProviderKeyRoots({
        PROVIDER_KEY_SECRET: CURRENT_HEX,
        PROVIDER_KEY_VERSION: "2",
        PROVIDER_KEY_PREVIOUS_SECRET: PREVIOUS_HEX,
        PROVIDER_KEY_PREVIOUS_VERSION: "1",
      }),
    ).toEqual({
      providerKeyRoot: { secret: parseProviderKeySecret(CURRENT_HEX), version: 2 },
      previousProviderKeyRoot: { secret: parseProviderKeySecret(PREVIOUS_HEX), version: 1 },
    });
    expect(() => readProviderKeyRoots({})).toThrow("PROVIDER_KEY_SECRET must be a 256-bit hex value");
    expect(() => readProviderKeyRoots({ PROVIDER_KEY_SECRET: "abcd" })).toThrow(
      "PROVIDER_KEY_SECRET must be a 256-bit hex value",
    );
    expect(() => readProviderKeyRoots({ PROVIDER_KEY_SECRET: ROOT_HEX, PROVIDER_KEY_VERSION: "-1" })).toThrow(
      "provider key version must be a non-negative integer",
    );
  });
});

describe("provider credential store", () => {
  it("stores a key and returns it only for that tenant and credential version", async () => {
    const { db } = await seeded();
    const providerKeyRoot = root(ROOT_HEX, 1);
    const stored = await upsertProviderCredential(db, {
      tenantId: USER,
      plaintext: KEY,
      root: providerKeyRoot,
      nowMs: NOW_MS,
      validatedAtMs: NOW_MS,
    });
    expect(stored.lastFour).toBe("1234");
    expect(stored.credentialVersion).toBe(1);
    expect(stored.keyVersion).toBe(1);
    expect(stored.status).toBe("active");
    expect(stored.createdAtMs).toBe(NOW_MS);
    expect(stored.validatedAtMs).toBe(NOW_MS);

    const read = await readProviderCredential(db, USER);
    expect(read?.lastFour).toBe("1234");
    expect(read?.credentialVersion).toBe(1);
    expect(
      await decryptProviderKey({
        roots: { providerKeyRoot },
        tenantId: USER,
        credentialVersion: read!.credentialVersion,
        keyVersion: read!.keyVersion,
        ciphertext: read!.ciphertext,
        iv: read!.iv,
      }),
    ).toBe("sk-test-key-1234");
    await expect(
      decryptProviderKey({
        roots: { providerKeyRoot },
        tenantId: OTHER,
        credentialVersion: 1,
        keyVersion: 1,
        ciphertext: stored.ciphertext,
        iv: stored.iv,
      }),
    ).rejects.toThrow("provider key ciphertext failed to decrypt");
  });

  it("bumps the credential version on replace and keeps the previous ciphertext sealed", async () => {
    const { db } = await seeded();
    const providerKeyRoot = root(ROOT_HEX, 1);
    const first = await upsertProviderCredential(db, {
      tenantId: USER,
      plaintext: KEY,
      root: providerKeyRoot,
      nowMs: NOW_MS,
      validatedAtMs: null,
    });
    const second = await upsertProviderCredential(db, {
      tenantId: USER,
      plaintext: REPLACED,
      root: providerKeyRoot,
      nowMs: NOW_MS + 10,
      validatedAtMs: NOW_MS + 10,
    });
    expect(second.credentialVersion).toBe(2);
    expect(second.lastFour).toBe("5678");
    expect(second.createdAtMs).toBe(NOW_MS);
    expect(second.updatedAtMs).toBe(NOW_MS + 10);
    expect(second.status).toBe("active");
    expect(
      await decryptProviderKey({
        roots: { providerKeyRoot },
        tenantId: USER,
        credentialVersion: 2,
        keyVersion: 1,
        ciphertext: second.ciphertext,
        iv: second.iv,
      }),
    ).toBe("sk-replaced-5678");
    await expect(
      decryptProviderKey({
        roots: { providerKeyRoot },
        tenantId: USER,
        credentialVersion: 1,
        keyVersion: 1,
        ciphertext: second.ciphertext,
        iv: second.iv,
      }),
    ).rejects.toThrow("provider key ciphertext failed to decrypt");
    expect(
      await decryptProviderKey({
        roots: { providerKeyRoot },
        tenantId: USER,
        credentialVersion: 1,
        keyVersion: 1,
        ciphertext: first.ciphertext,
        iv: first.iv,
      }),
    ).toBe("sk-test-key-1234");
  });

  it("marks invalid only the named credential version", async () => {
    const { db } = await seeded();
    await upsertProviderCredential(db, {
      tenantId: USER,
      plaintext: KEY,
      root: root(ROOT_HEX, 1),
      nowMs: NOW_MS,
      validatedAtMs: NOW_MS,
    });
    expect(
      await markProviderCredentialInvalid(db, { tenantId: USER, credentialVersion: 2, nowMs: NOW_MS + 1 }),
    ).toBe(false);
    expect((await readProviderCredential(db, USER))?.status).toBe("active");
    expect(
      await markProviderCredentialInvalid(db, { tenantId: USER, credentialVersion: 1, nowMs: NOW_MS + 2 }),
    ).toBe(true);
    const invalid = await readProviderCredential(db, USER);
    expect(invalid?.status).toBe("invalid");
    expect(invalid?.updatedAtMs).toBe(NOW_MS + 2);
    expect(invalid?.credentialVersion).toBe(1);
  });

  it("keeps an Anthropic row independent of the same tenant's OpenAI row", async () => {
    const { db } = await seeded();
    const providerKeyRoot = root(ROOT_HEX, 1);
    const store = (plaintext: string, provider: "openai" | "anthropic", nowMs: number) =>
      upsertProviderCredential(db, { tenantId: USER, plaintext, root: providerKeyRoot, nowMs, validatedAtMs: nowMs, provider });
    await store(KEY, "openai", NOW_MS);
    await store("sk-ant-first-0001", "anthropic", NOW_MS + 1);
    const replaced = await store("sk-ant-second-0002", "anthropic", NOW_MS + 2);
    expect(replaced).toMatchObject({ provider: "anthropic", credentialVersion: 2, lastFour: "0002" });
    expect(
      await decryptProviderKey({
        roots: { providerKeyRoot },
        tenantId: USER,
        credentialVersion: replaced.credentialVersion,
        keyVersion: replaced.keyVersion,
        ciphertext: replaced.ciphertext,
        iv: replaced.iv,
      }),
    ).toBe("sk-ant-second-0002");
    expect(await readProviderCredential(db, USER, "openai")).toMatchObject({ credentialVersion: 1, lastFour: "1234" });

    // The OpenAI row is at version 1 too: the fence names the provider.
    expect(
      await markProviderCredentialInvalid(db, { tenantId: USER, provider: "anthropic", credentialVersion: 1, nowMs: NOW_MS + 3 }),
    ).toBe(false);
    expect(
      await markProviderCredentialInvalid(db, { tenantId: USER, provider: "anthropic", credentialVersion: 2, nowMs: NOW_MS + 3 }),
    ).toBe(true);
    expect((await readProviderCredential(db, USER, "anthropic"))?.status).toBe("invalid");
    expect((await readProviderCredential(db, USER, "openai"))?.status).toBe("active");

    await deleteProviderCredential(db, { tenantId: USER, provider: "anthropic" });
    expect(await readProviderCredential(db, USER, "anthropic")).toBeNull();
    expect(await readProviderCredential(db, USER, "openai")).toMatchObject({ status: "active", lastFour: "1234" });
  });
});
