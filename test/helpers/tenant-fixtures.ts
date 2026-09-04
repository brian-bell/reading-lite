import { deriveHmacKey, hmacHex, parseAuthRootSecret } from "../../src/control-plane/crypto";
import { parseTenantId, mintTokenId, mintUserId, type TenantContext } from "../../src/control-plane/ids";
import { API_SCOPES } from "../../src/control-plane/principal";
import { FOUNDER_PLACEHOLDER_LIMITS } from "../../src/control-plane/bootstrap";
import type { Env } from "../../src/index";
import {
  readingStoreFor,
  type ListIndexCasDeps,
  type ReadingStore,
} from "../../src/modules/stores/reading-store";

export const FOUNDER_TENANT_ID = "usr_550e8400-e29b-41d4-a716-446655440000";
export const OTHER_TENANT_ID = "usr_11111111-1111-4111-8111-111111111111";
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

export function testReadingStore(
  env: { READINGS_BUCKET: R2Bucket; TENANT_DATA_PLANE?: string },
  tenant: TenantContext = founderTenant(),
  casDeps: ListIndexCasDeps = {},
): ReadingStore {
  return readingStoreFor(env.READINGS_BUCKET, tenant, env, casDeps);
}

export async function insertSecondTenant(env: Env): Promise<{
  tenantId: string;
  token: string;
}> {
  const nowMs = Date.now();
  const secretHmac = await hmacHex(
    await deriveHmacKey({ secret: parseAuthRootSecret(env.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
    OTHER_TOKEN_SECRET,
  );
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO users (
       id, email_canonical, email_display, status,
       email_verified_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, 'other@test.example', 'other@test.example', 'active', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(OTHER_TENANT_ID, nowMs, nowMs, nowMs)
    .run();
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO user_settings (
       user_id, schema_version, notify_immediate, digest_cadence,
       time_zone, digest_hour_local, digest_weekday, created_at_ms, updated_at_ms
     ) VALUES (?, 1, 1, 'off', 'UTC', 9, 1, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  )
    .bind(OTHER_TENANT_ID, nowMs, nowMs)
    .run();
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO tenant_limits (
       tenant_id, policy_version, submissions_per_hour, monthly_readings,
       max_concurrent_work, daily_spend_microdollars, created_at_ms, updated_at_ms
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO NOTHING`,
  )
    .bind(
      OTHER_TENANT_ID,
      100_000,
      100_000,
      FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
      FOUNDER_PLACEHOLDER_LIMITS.daily_spend_microdollars,
      nowMs,
      nowMs,
    )
    .run();
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO api_tokens (
       id, user_id, name, format, secret_hmac, hash_key_version, created_at_ms, expires_at_ms
     ) VALUES (?, ?, 'other', 'legacy', ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(OTHER_TOKEN_ID, OTHER_TENANT_ID, secretHmac, nowMs, nowMs + 60_000)
    .run();
  for (const scope of API_SCOPES) {
    await env.CONTROL_PLANE.prepare(
      "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, ?) ON CONFLICT(token_id, scope) DO NOTHING",
    )
      .bind(OTHER_TOKEN_ID, scope)
      .run();
  }
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
  const nowMs = Date.now();
  const tenantId = mintUserId();
  const tokenId = mintTokenId();
  const token = `quota-test-token-${crypto.randomUUID()}`;
  const secretHmac = await hmacHex(
    await deriveHmacKey({ secret: parseAuthRootSecret(env.AUTH_ROOT_SECRET), version: 1 }, "api_token"),
    token,
  );
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO users (
       id, email_canonical, email_display, status,
       email_verified_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(tenantId, `${tenantId}@test.example`, `${tenantId}@test.example`, nowMs, nowMs, nowMs)
    .run();
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO user_settings (
       user_id, schema_version, notify_immediate, digest_cadence,
       time_zone, digest_hour_local, digest_weekday, created_at_ms, updated_at_ms
     ) VALUES (?, 1, 1, 'off', 'UTC', 9, 1, ?, ?)`,
  )
    .bind(tenantId, nowMs, nowMs)
    .run();
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO tenant_limits (
       tenant_id, policy_version, submissions_per_hour, monthly_readings,
       max_concurrent_work, daily_spend_microdollars, created_at_ms, updated_at_ms
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      tenantId,
      limits.submissions_per_hour,
      limits.monthly_readings,
      limits.max_concurrent_work ?? FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
      FOUNDER_PLACEHOLDER_LIMITS.daily_spend_microdollars,
      nowMs,
      nowMs,
    )
    .run();
  await env.CONTROL_PLANE.prepare(
    `INSERT INTO api_tokens (
       id, user_id, name, format, secret_hmac, hash_key_version, created_at_ms, expires_at_ms
     ) VALUES (?, ?, 'quota', 'legacy', ?, 1, ?, ?)`,
  )
    .bind(tokenId, tenantId, secretHmac, nowMs, nowMs + 60_000)
    .run();
  for (const scope of API_SCOPES) {
    await env.CONTROL_PLANE.prepare(
      "INSERT INTO api_token_scopes (token_id, scope) VALUES (?, ?) ON CONFLICT(token_id, scope) DO NOTHING",
    )
      .bind(tokenId, scope)
      .run();
  }
  return { tenantId, token };
}
