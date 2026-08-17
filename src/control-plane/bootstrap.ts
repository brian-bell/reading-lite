import { deriveHmacKey, hmacHex, type AuthRoot } from "./crypto";
import type { ControlPlaneDb, SqlStatement } from "./db";
import { canonicalizeEmail } from "./email";
import { mintTokenId, mintUserId, parseTokenId, parseUserId, type TokenId, type UserId } from "./ids";
import { API_SCOPES } from "./principal";

export const TOKEN_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const FOUNDER_PLACEHOLDER_LIMITS = {
  submissions_per_hour: 20,
  monthly_readings: 200,
  max_concurrent_work: 2,
  daily_spend_microdollars: 1_000_000,
} as const;

export type SignupMode = "closed" | "invite_only" | "open";

export interface FounderBootstrapInput {
  email: string;
  legacyToken: string;
  signupMode: SignupMode;
  nowMs: number;
  authRoot: AuthRoot;
  previousAuthRoot?: AuthRoot;
  newUserId?: () => string;
  newTokenId?: () => string;
}

export interface FounderBootstrapResult {
  userId: UserId;
  tokenId: TokenId;
  createdUser: boolean;
  createdToken: boolean;
  actions: string[];
}

export function signupModeForEnv(env: "local" | "staging" | "production"): SignupMode {
  if (env === "production") return "closed";
  if (env === "staging") return "invite_only";
  return "open";
}

export async function bootstrapFounder(
  db: ControlPlaneDb,
  input: FounderBootstrapInput,
  opts: { apply?: boolean } = {},
): Promise<FounderBootstrapResult> {
  const apply = opts.apply !== false;
  const emailDisplay = input.email.trim();
  const emailCanonical = canonicalizeEmail(input.email);
  if (!input.legacyToken) throw new Error("legacy token is required");

  const secretHmac = await legacyTokenHmac(input.legacyToken, input.authRoot);

  const existingUser = await db.first<{ id: string }>(
    "SELECT id FROM users WHERE email_canonical = ?",
    emailCanonical,
  );
  const existingToken = await lookupExistingLegacyToken(
    db,
    input.legacyToken,
    input.authRoot,
    input.previousAuthRoot,
  );

  const userId = existingUser
    ? requireUserId(existingUser.id)
    : requireUserId(input.newUserId?.() ?? mintUserId());
  const tokenId = existingToken
    ? requireTokenId(existingToken.id)
    : requireTokenId(input.newTokenId?.() ?? mintTokenId());

  if (existingToken) {
    if (existingToken.format !== "legacy") {
      throw new Error(
        "legacy token HMAC matches a non-legacy api_tokens row; refusing to grant scopes",
      );
    }
    if (existingToken.user_id !== userId) {
      throw new Error("legacy token HMAC is owned by a different user; refusing to grant scopes");
    }
  }

  const existingPolicy = await db.first<{ signup_mode: string }>(
    "SELECT signup_mode FROM system_policy WHERE id = 1",
  );
  if (existingPolicy && existingPolicy.signup_mode !== input.signupMode) {
    throw new Error(
      `system_policy signup_mode is ${existingPolicy.signup_mode}, refusing to change it to ${input.signupMode}`,
    );
  }

  const createdUser = existingUser === null;
  const createdToken = existingToken === null;
  const actions = [
    createdUser ? `create user ${userId}` : `resolve user ${userId}`,
    createdToken ? `import legacy token ${tokenId}` : `resolve legacy token ${tokenId}`,
    "ensure default settings",
    "ensure placeholder tenant limits",
    "ensure token scopes",
    `ensure system_policy signup_mode=${input.signupMode}`,
  ];

  if (!apply) {
    return { userId, tokenId, createdUser, createdToken, actions };
  }

  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO users (
              id, email_canonical, email_display, status,
              email_verified_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(email_canonical) DO NOTHING`,
      params: [userId, emailCanonical, emailDisplay, input.nowMs, input.nowMs, input.nowMs],
    },
    {
      sql: `INSERT INTO user_settings (
              user_id, schema_version, notify_immediate, digest_cadence,
              time_zone, digest_hour_local, digest_weekday, created_at_ms, updated_at_ms
            ) SELECT id, 1, 1, 'off', 'UTC', 9, 1, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(user_id) DO NOTHING`,
      params: [input.nowMs, input.nowMs, emailCanonical],
    },
    {
      sql: `INSERT INTO tenant_limits (
              tenant_id, policy_version, submissions_per_hour, monthly_readings,
              max_concurrent_work, daily_spend_microdollars, created_at_ms, updated_at_ms
            ) SELECT id, 1, ?, ?, ?, ?, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(tenant_id) DO NOTHING`,
      params: [
        FOUNDER_PLACEHOLDER_LIMITS.submissions_per_hour,
        FOUNDER_PLACEHOLDER_LIMITS.monthly_readings,
        FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
        FOUNDER_PLACEHOLDER_LIMITS.daily_spend_microdollars,
        input.nowMs,
        input.nowMs,
        emailCanonical,
      ],
    },
    ...(existingToken
      ? [
          {
            sql: `UPDATE api_tokens
                  SET secret_hmac = ?, hash_key_version = ?
                  WHERE id = ?`,
            params: [secretHmac, input.authRoot.version, tokenId],
          },
        ]
      : [
          {
            sql: `INSERT INTO api_tokens (
                    id, user_id, name, format, secret_hmac, hash_key_version,
                    created_at_ms, expires_at_ms
                  ) SELECT ?, id, 'Imported legacy READER_API_TOKEN', 'legacy', ?, ?, ?, ?
                    FROM users WHERE email_canonical = ?
                  ON CONFLICT(secret_hmac) DO NOTHING`,
            params: [
              tokenId,
              secretHmac,
              input.authRoot.version,
              input.nowMs,
              input.nowMs + TOKEN_MAX_TTL_MS,
              emailCanonical,
            ],
          },
        ]),
    ...API_SCOPES.map((scope) => ({
      sql: `INSERT INTO api_token_scopes (token_id, scope)
            VALUES (?, ?)
            ON CONFLICT(token_id, scope) DO NOTHING`,
      params: [tokenId, scope],
    })),
    ...(existingPolicy
      ? []
      : [
          {
            sql: `INSERT INTO system_policy (
                    id, signup_mode, paid_work_enabled, policy_version, catalog_version, updated_at_ms
                  ) VALUES (1, ?, 1, 1, 1, ?)`,
            params: [input.signupMode, input.nowMs],
          },
        ]),
  ];

  await db.batch(statements);

  const resolvedUser = await db.first<{ id: string }>(
    "SELECT id FROM users WHERE email_canonical = ?",
    emailCanonical,
  );
  const resolvedToken = await db.first<{ id: string }>(
    "SELECT id FROM api_tokens WHERE id = ?",
    tokenId,
  );
  if (!resolvedUser || !resolvedToken) {
    throw new Error("founder bootstrap failed to persist user or token");
  }

  return {
    userId: requireUserId(resolvedUser.id),
    tokenId: requireTokenId(resolvedToken.id),
    createdUser,
    createdToken,
    actions,
  };
}

function requireUserId(raw: string): UserId {
  const parsed = parseUserId(raw);
  if (!parsed) throw new Error("malformed user id");
  return parsed;
}

function requireTokenId(raw: string): TokenId {
  const parsed = parseTokenId(raw);
  if (!parsed) throw new Error("malformed token id");
  return parsed;
}

async function legacyTokenHmac(legacyToken: string, root: AuthRoot): Promise<string> {
  return hmacHex(await deriveHmacKey(root, "api_token"), legacyToken);
}

async function lookupExistingLegacyToken(
  db: ControlPlaneDb,
  legacyToken: string,
  authRoot: AuthRoot,
  previousAuthRoot?: AuthRoot,
): Promise<{ id: string; user_id: string; format: string } | null> {
  const roots = previousAuthRoot ? [authRoot, previousAuthRoot] : [authRoot];
  for (const root of roots) {
    const digest = await legacyTokenHmac(legacyToken, root);
    const row = await db.first<{ id: string; user_id: string; format: string }>(
      "SELECT id, user_id, format FROM api_tokens WHERE secret_hmac = ?",
      digest,
    );
    if (row) return row;
  }
  return null;
}
