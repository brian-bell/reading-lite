import { describe, expect, it } from "vitest";
import { bootstrapFounder } from "../../../src/control-plane/bootstrap";
import { parseAuthRootSecret, parseProviderKeySecret } from "../../../src/control-plane/crypto";
import {
  deleteProviderCredential,
  markProviderCredentialInvalid,
  upsertProviderCredential,
  type ProviderName,
} from "../../../src/control-plane/provider-credentials";
import { loadProviderSettings, updateProviderPreferences } from "../../../src/control-plane/provider-settings";
import { useControlPlane } from "../../helpers/control-plane-pg";

const openControlPlane = useControlPlane();
const ROOT_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");
const USER = "usr_550e8400-e29b-41d4-a716-446655440000";

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
  const store = (provider: ProviderName, plaintext: string) =>
    upsertProviderCredential(db, {
      tenantId: USER,
      plaintext,
      root: { secret: parseProviderKeySecret(SECRET), version: 1 },
      nowMs: NOW_MS,
      validatedAtMs: NOW_MS,
      provider,
    });
  const settings = async () => {
    const loaded = await loadProviderSettings(db, USER);
    if (typeof loaded === "string") throw new Error(loaded);
    return loaded;
  };
  return { db, store, settings };
}

describe("summarization provider selection", () => {
  it("shows each key's mask and the selection, defaulting to OpenAI", async () => {
    const { store, settings } = await seeded();
    expect(await settings()).toMatchObject({ credential: null, anthropic_credential: null, summarization_provider: "openai" });

    await store("openai", "sk-openai-1111");
    await store("anthropic", "sk-ant-2222");
    expect(await settings()).toMatchObject({
      credential: { provider: "openai", last_four: "1111", status: "active", validated_at_ms: NOW_MS },
      anthropic_credential: { provider: "anthropic", last_four: "2222", status: "active", validated_at_ms: NOW_MS },
      summarization_provider: "openai",
    });
  });

  it("refuses Anthropic without an active Anthropic key and changes nothing else in the request", async () => {
    const { db, store, settings } = await seeded();
    await store("openai", "sk-openai-1111");
    const select = () =>
      updateProviderPreferences(db, { userId: USER, nowMs: NOW_MS + 1, summarizationProvider: "anthropic", effort: "low" });

    expect(await select()).toBe("anthropic_key_required");
    const anthropic = await store("anthropic", "sk-ant-2222");
    await markProviderCredentialInvalid(db, {
      tenantId: USER,
      provider: "anthropic",
      credentialVersion: anthropic.credentialVersion,
      nowMs: NOW_MS,
    });
    expect(await select()).toBe("anthropic_key_required");
    expect(await settings()).toMatchObject({ summarization_provider: "openai", effort: "high" });

    await store("anthropic", "sk-ant-3333");
    expect(await select()).toBe("ok");
    expect(await settings()).toMatchObject({ summarization_provider: "anthropic", effort: "low" });
    expect(await updateProviderPreferences(db, { userId: USER, nowMs: NOW_MS + 2, summarizationProvider: "openai" })).toBe("ok");
    expect(await settings()).toMatchObject({ summarization_provider: "openai" });
  });

  it("keeps the selection when the Anthropic key goes invalid", async () => {
    const { db, store, settings } = await seeded();
    const anthropic = await store("anthropic", "sk-ant-2222");
    await updateProviderPreferences(db, { userId: USER, nowMs: NOW_MS, summarizationProvider: "anthropic" });
    await markProviderCredentialInvalid(db, {
      tenantId: USER,
      provider: "anthropic",
      credentialVersion: anthropic.credentialVersion,
      nowMs: NOW_MS + 1,
    });
    expect(await settings()).toMatchObject({
      anthropic_credential: { status: "invalid" },
      summarization_provider: "anthropic",
    });
  });

  it.each([
    { removed: "anthropic" as const, selection: "openai", left: { credential: { last_four: "1111" }, anthropic_credential: null } },
    { removed: "openai" as const, selection: "anthropic", left: { credential: null, anthropic_credential: { last_four: "2222" } } },
  ])("removing the $removed key leaves the selection $selection", async ({ removed, selection, left }) => {
    const { db, store, settings } = await seeded();
    await store("openai", "sk-openai-1111");
    await store("anthropic", "sk-ant-2222");
    await updateProviderPreferences(db, { userId: USER, nowMs: NOW_MS, summarizationProvider: "anthropic" });

    await deleteProviderCredential(db, { tenantId: USER, provider: removed });
    expect(await settings()).toMatchObject({ ...left, summarization_provider: selection });
  });
});
