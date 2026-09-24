import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import { parseTenantId, mintTokenId, mintUserId, type TenantContext } from "../../src/control-plane/ids";
import { API_SCOPES } from "../../src/control-plane/principal";
import { FOUNDER_PLACEHOLDER_LIMITS } from "../../src/control-plane/bootstrap";
import { toTimestamp } from "../../src/control-plane/pg-time";
import type { Env } from "../../src/index";
import { resolveAttemptId, type ProcessReadingArgs } from "../../src/attempt-ownership";

import { testControlPlane } from "./control-plane-db";
import { FOUNDER_TENANT_ID, OTHER_TENANT_ID } from "./file-tenants";

// Per test file, not fixed: see ./file-tenants.ts.
export { FOUNDER_TENANT_ID, OTHER_TENANT_ID };
export const OTHER_TOKEN_SECRET = "other-test-token";
export const OTHER_TOKEN_ID = "tok_11111111-1111-4111-8111-111111111111";

// Public A record for extractor SSRF tests that never actually connect.
export const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34" }];

export function founderTenant(): TenantContext {
  return { tenantId: parseTenantId(FOUNDER_TENANT_ID)! };
}

export function otherTenant(): TenantContext {
  return { tenantId: parseTenantId(OTHER_TENANT_ID)! };
}

/**
 * Reserve the attempt's reading slot, as intake does before it enqueues a job.
 * Tests that seed a pending job and call processReading directly need this:
 * summarize refuses to dispatch against a slot it no longer holds (#320).
 */
export async function reserveReadingSlot(
  env: { TENANT_USAGE_GUARD?: DurableObjectNamespace },
  tenant: TenantContext,
  args: ProcessReadingArgs,
): Promise<void> {
  const ns = env.TENANT_USAGE_GUARD!;
  const tenantId = String(tenant.tenantId);
  const res = await ns.get(ns.idFromName(tenantId)).fetch("https://tenant-usage-guard/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "reserve_reading", tenantId, opId: resolveAttemptId(args), nowMs: Date.now() }),
  });
  const decision = (await res.json()) as { ok?: boolean };
  if (decision.ok !== true) throw new Error(`reserve_reading failed: ${JSON.stringify(decision)}`);
}

// A user with default settings, limits and a legacy-format token holding every
// scope: what the founder bootstrap gives the founder, for another tenant.
async function insertTenantWithToken(
  env: Env,
  input: {
    tenantId: string;
    email: string;
    tokenId: string;
    token: string;
    tokenName: string;
    submissionsPerHour: number;
    monthlyReadings: number;
    maxConcurrentWork: number;
  },
): Promise<void> {
  const now = toTimestamp(Date.now());
  const secretHmac = await hmacHex(
    await deriveHmacKey({ secret: parseAuthRootSecret(env.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
    input.token,
  );
  await testControlPlane(env).batch([
    {
      sql: `INSERT INTO users (id, email_canonical, email_display, status, email_verified_at, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT (id) DO NOTHING`,
      params: [input.tenantId, input.email, input.email, now, now, now],
    },
    {
      sql: `INSERT INTO user_settings (
              user_id, schema_version, notify_immediate, digest_cadence,
              time_zone, digest_hour_local, digest_weekday, created_at, updated_at
            ) VALUES (?, 1, true, 'off', 'UTC', 9, 1, ?, ?)
            ON CONFLICT (user_id) DO NOTHING`,
      params: [input.tenantId, now, now],
    },
    {
      sql: `INSERT INTO tenant_limits (
              tenant_id, policy_version, submissions_per_hour, monthly_readings,
              max_concurrent_work, daily_spend_microdollars, created_at, updated_at
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id) DO NOTHING`,
      params: [
        input.tenantId,
        input.submissionsPerHour,
        input.monthlyReadings,
        input.maxConcurrentWork,
        FOUNDER_PLACEHOLDER_LIMITS.daily_spend_microdollars,
        now,
        now,
      ],
    },
    {
      sql: `INSERT INTO api_tokens (id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at)
            VALUES (?, ?, ?, 'legacy', ?, 1, ?, ?)
            ON CONFLICT (id) DO NOTHING`,
      params: [input.tokenId, input.tenantId, input.tokenName, secretHmac, now, toTimestamp(Date.now() + 60_000)],
    },
    ...API_SCOPES.map((scope) => ({
      sql: "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, ?) ON CONFLICT (token_id, scope) DO NOTHING",
      params: [input.tokenId, scope],
    })),
  ]);
}

export async function insertSecondTenant(env: Env): Promise<{
  tenantId: string;
  token: string;
}> {
  await insertTenantWithToken(env, {
    tenantId: OTHER_TENANT_ID,
    email: "other@test.example",
    tokenId: OTHER_TOKEN_ID,
    token: OTHER_TOKEN_SECRET,
    tokenName: "other",
    submissionsPerHour: 100_000,
    monthlyReadings: 100_000,
    maxConcurrentWork: FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
  });
  return { tenantId: OTHER_TENANT_ID, token: OTHER_TOKEN_SECRET };
}

export async function insertQuotaTenant(
  env: Env,
  limits: {
    submissions_per_hour: number;
    monthly_readings: number;
    max_concurrent_work?: number;
  },
): Promise<{ tenantId: string; token: string }> {
  const tenantId = mintUserId();
  const token = `quota-test-token-${crypto.randomUUID()}`;
  await insertTenantWithToken(env, {
    tenantId,
    email: `${tenantId}@test.example`,
    tokenId: mintTokenId(),
    token,
    tokenName: "quota",
    submissionsPerHour: limits.submissions_per_hour,
    monthlyReadings: limits.monthly_readings,
    maxConcurrentWork: limits.max_concurrent_work ?? FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
  });
  return { tenantId, token };
}
