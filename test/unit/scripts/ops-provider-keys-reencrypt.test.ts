// Blackbox cases for `ops provider-keys reencrypt` (reading-lite-gh341.12):
// seed credential rows sealed under real roots, run the real command against
// PostgreSQL, and assert on what the rows hold afterwards. Encryption itself
// belongs to test/unit/control-plane/provider-credentials.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { providerKeysReencryptCommand } from "../../../scripts/ops-lib/commands/provider-keys-reencrypt";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { parseProviderKeySecret } from "../../../src/control-plane/crypto";
import { fromSql } from "../../../src/control-plane/db";
import { decryptProviderKey, type ProviderKeyRoot } from "../../../src/control-plane/provider-key-crypto";
import {
  readProviderCredential,
  reencryptProviderCredential,
  upsertProviderCredential,
} from "../../../src/control-plane/provider-credentials";
import type { Sql } from "../../../src/modules/db/sql";
import { captureIo, operatorSession, seedTenant, useCorpusDatabase } from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase();

const PREVIOUS_HEX = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const CURRENT_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const STRANGER_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW_MS = Date.parse("2026-09-30T12:00:00.000Z");
const KEYS = ["sk-first-key-aaaa", "sk-second-key-bbbb", "sk-third-key-cccc"];

const root = (secret: string, version: number): ProviderKeyRoot => ({ secret: parseProviderKeySecret(secret), version });
const PREVIOUS = root(PREVIOUS_HEX, 1);
const CURRENT = root(CURRENT_HEX, 2);

const ROTATION_VARS = {
  STAGING_DATABASE_URL: "postgres://test/staging",
  PROVIDER_KEY_SECRET: CURRENT_HEX,
  PROVIDER_KEY_VERSION: "2",
  PROVIDER_KEY_PREVIOUS_SECRET: PREVIOUS_HEX,
  PROVIDER_KEY_PREVIOUS_VERSION: "1",
};

let sql: Sql;

beforeEach(() => {
  sql = sqlFor();
});

function run(argv: string[], vars: Record<string, string | undefined> = ROTATION_VARS) {
  const io = captureIo();
  const session = operatorSession(() => sql);
  const envs: string[] = [];
  const deps = {
    io: io.io,
    openSql: session.openSql,
    vars: (env: string) => {
      envs.push(env);
      return vars;
    },
  };
  return { io, session, envs, code: providerKeysReencryptCommand.run(argv, deps) };
}

async function seedKey(sealedBy: ProviderKeyRoot, plaintext: string, replaces = 0): Promise<string> {
  const tenantId = String((await seedTenant(sql)).tenantId);
  for (let i = 0; i <= replaces; i++) {
    await upsertProviderCredential(fromSql(sql), { tenantId, plaintext, root: sealedBy, nowMs: NOW_MS, validatedAtMs: NOW_MS });
  }
  return tenantId;
}

async function stored(tenantId: string) {
  const row = await readProviderCredential(fromSql(sql), tenantId);
  if (!row) throw new Error(`no credential for ${tenantId}`);
  return row;
}

async function openWith(tenantId: string, only: ProviderKeyRoot): Promise<string> {
  const row = await stored(tenantId);
  return decryptProviderKey({
    roots: { providerKeyRoot: only },
    tenantId,
    credentialVersion: row.credentialVersion,
    keyVersion: row.keyVersion,
    ciphertext: row.ciphertext,
    iv: row.iv,
  });
}

function summary(out: string[]) {
  return JSON.parse(out.at(-1)!);
}

describe("ops provider-keys reencrypt", () => {
  it("plans counts per key_version, writes nothing and prints no key", async () => {
    const resealable = await seedKey(PREVIOUS, KEYS[0]!);
    await seedKey(CURRENT, KEYS[1]!);
    const before = await stored(resealable);

    const { io, code, envs } = run(["--env", "staging"]);
    expect(await code).toBe(0);
    expect(envs).toEqual(["staging"]);
    expect(summary(io.out)).toMatchObject({
      mode: "plan",
      current_key_version: 2,
      previous_key_version: 1,
      rows: 2,
      by_key_version: [
        { key_version: 1, rows: 1, current: 0, reseal: 1, undecryptable: 0 },
        { key_version: 2, rows: 1, current: 1, reseal: 0, undecryptable: 0 },
      ],
      rows_reencrypted: 0,
      rows_remaining: 1,
    });
    expect(await stored(resealable)).toEqual(before);
    for (const key of KEYS) expect(io.all()).not.toContain(key);
  });

  it("--execute reseals every previous-version row under the current version, keeping its credential version", async () => {
    const replaced = await seedKey(PREVIOUS, KEYS[0]!, 2);
    const fresh = await seedKey(PREVIOUS, KEYS[1]!);
    const alreadyCurrent = await seedKey(CURRENT, KEYS[2]!);
    const [replacedBefore, currentBefore] = [await stored(replaced), await stored(alreadyCurrent)];

    const { io, code } = run(["--env", "staging", "--execute"]);
    expect(await code).toBe(0);
    expect(summary(io.out)).toMatchObject({ mode: "execute", rows: 3, rows_reencrypted: 2, rows_remaining: 0 });

    const replacedAfter = await stored(replaced);
    expect(replacedAfter).toMatchObject({
      keyVersion: 2,
      credentialVersion: replacedBefore.credentialVersion,
      lastFour: replacedBefore.lastFour,
      status: replacedBefore.status,
      updatedAtMs: replacedBefore.updatedAtMs,
    });
    expect(replacedAfter.credentialVersion).toBe(3);
    expect(await openWith(replaced, CURRENT)).toBe(KEYS[0]);
    expect(await openWith(fresh, CURRENT)).toBe(KEYS[1]);
    expect(await stored(alreadyCurrent)).toEqual(currentBefore);
    for (const key of KEYS) expect(io.all()).not.toContain(key);
  });

  it("--execute leaves a row neither secret opens, names its tenant, and exits 1", async () => {
    const resealable = await seedKey(PREVIOUS, KEYS[0]!);
    const lost = await seedKey(root(STRANGER_HEX, 0), KEYS[1]!);

    const { io, code } = run(["--env", "staging", "--execute"]);
    expect(await code).toBe(1);
    expect(summary(io.out)).toMatchObject({ rows_reencrypted: 1, rows_remaining: 1 });
    expect(io.err.join("\n")).toContain(`${lost} openai key_version 0 credential_version 1`);
    expect((await stored(lost)).keyVersion).toBe(0);
    expect(await openWith(resealable, CURRENT)).toBe(KEYS[0]);
  });

  it("--execute writes nothing when a row on the current version does not open under the supplied secret", async () => {
    const resealable = await seedKey(PREVIOUS, KEYS[0]!);
    await seedKey(CURRENT, KEYS[1]!);
    const before = await stored(resealable);

    const { io, code } = run(["--env", "staging", "--execute"], { ...ROTATION_VARS, PROVIDER_KEY_SECRET: STRANGER_HEX });
    expect(await code).toBe(1);
    expect(io.err.join("\n")).toContain("it is not the secret the Worker seals with. Nothing was written.");
    expect(await stored(resealable)).toEqual(before);
  });

  it.each([
    { name: "no --env", argv: [], vars: ROTATION_VARS, message: "--env is required" },
    {
      name: "a production execute without --confirm-production",
      argv: ["--env", "production", "--execute"],
      vars: ROTATION_VARS,
      message: "--confirm-production is required",
    },
    {
      name: "no current secret",
      argv: ["--env", "staging"],
      vars: { ...ROTATION_VARS, PROVIDER_KEY_SECRET: undefined },
      message: "PROVIDER_KEY_SECRET must be a 256-bit hex value",
    },
    {
      name: "equal current and previous versions",
      argv: ["--env", "staging"],
      vars: { ...ROTATION_VARS, PROVIDER_KEY_VERSION: "1" },
      message: "a rotation that re-encrypts must bump PROVIDER_KEY_VERSION",
    },
  ])("refuses $name before connecting", async ({ argv, vars, message }) => {
    const { code, session } = run(argv, vars);
    await expect(code).rejects.toThrow(UsageError);
    await expect(code).rejects.toThrow(message);
    expect(session.urls()).toEqual([]);
  });
});

describe("reencryptProviderCredential under the row lock", () => {
  it("leaves a row replaced under the current root since it was listed", async () => {
    const tenantId = await seedKey(CURRENT, KEYS[0]!);
    const before = await stored(tenantId);
    expect(await reencryptProviderCredential(fromSql(sql), { tenantId, from: PREVIOUS, to: CURRENT })).toBe("current");
    expect(await stored(tenantId)).toEqual(before);
  });
});
