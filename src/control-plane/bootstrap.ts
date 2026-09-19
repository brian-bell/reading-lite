import { TOKEN_MAX_TTL_MS } from "./constants";
import { deriveHmacKey, hmacHex, type AuthRoot } from "./crypto";
import { lockKey, type ControlPlaneDb, type SqlStatement } from "./db";
import { canonicalizeEmail } from "./email";
import { mintTokenId, mintUserId, parseTokenId, parseUserId, type TokenId, type UserId } from "./ids";
import { toTimestamp } from "./pg-time";
import { API_SCOPES } from "./principal";

export { TOKEN_MAX_TTL_MS };

export const FOUNDER_PLACEHOLDER_LIMITS = {
  submissions_per_hour: 20,
  monthly_readings: 200,
  max_concurrent_work: 2,
  daily_spend_microdollars: 1_000_000,
} as const;

/** Global processing concurrency placeholder. Do not treat as production economics (s1k.9.5). */
export const GLOBAL_PLACEHOLDER_CONCURRENCY = 3;

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

// Reads what exists, then writes what is missing, as one transaction under a
// fixed advisory lock: two bootstraps racing on an empty database would
// otherwise both decide to create, and the rows they would lock FOR UPDATE do
// not exist yet.
export async function bootstrapFounder(
  db: ControlPlaneDb,
  input: FounderBootstrapInput,
  opts: { apply?: boolean } = {},
): Promise<FounderBootstrapResult> {
  return db.transaction(async (tx) => {
    await lockKey(tx, "founder_bootstrap");
    return bootstrapFounderLocked(tx, input, opts);
  });
}

async function bootstrapFounderLocked(
  db: ControlPlaneDb,
  input: FounderBootstrapInput,
  opts: { apply?: boolean },
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

  const now = toTimestamp(input.nowMs);
  const tokenExpires = toTimestamp(input.nowMs + TOKEN_MAX_TTL_MS);
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO users (
              id, email_canonical, email_display, status,
              email_verified_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'active', ?, ?, ?)
            ON CONFLICT(email_canonical) DO NOTHING`,
      params: [userId, emailCanonical, emailDisplay, now, now, now],
    },
    {
      sql: `INSERT INTO user_settings (
              user_id, schema_version, notify_immediate, digest_cadence,
              time_zone, digest_hour_local, digest_weekday, created_at, updated_at
            ) SELECT id, 1, true, 'off', 'UTC', 9, 1, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(user_id) DO NOTHING`,
      params: [now, now, emailCanonical],
    },
    {
      sql: `INSERT INTO tenant_limits (
              tenant_id, policy_version, submissions_per_hour, monthly_readings,
              max_concurrent_work, daily_spend_microdollars, created_at, updated_at
            ) SELECT id, 1, ?, ?, ?, ?, ?, ?
              FROM users WHERE email_canonical = ?
            ON CONFLICT(tenant_id) DO NOTHING`,
      params: [
        FOUNDER_PLACEHOLDER_LIMITS.submissions_per_hour,
        FOUNDER_PLACEHOLDER_LIMITS.monthly_readings,
        FOUNDER_PLACEHOLDER_LIMITS.max_concurrent_work,
        FOUNDER_PLACEHOLDER_LIMITS.daily_spend_microdollars,
        now,
        now,
        emailCanonical,
      ],
    },
    ...(existingToken
      ? [
          {
            sql: `UPDATE api_tokens
                  SET secret_hmac = ?, hash_key_version = ?, expires_at = ?, revoked_at = NULL
                  WHERE id = ?`,
            params: [secretHmac, input.authRoot.version, tokenExpires, tokenId],
          },
        ]
      : [
          {
            sql: `INSERT INTO api_tokens (
                    id, user_id, name, format, secret_hmac, hash_key_version,
                    created_at, expires_at
                  ) SELECT ?, id, 'Imported legacy READER_API_TOKEN', 'legacy', ?, ?, ?, ?
                    FROM users WHERE email_canonical = ?
                  ON CONFLICT(secret_hmac) DO NOTHING`,
            params: [tokenId, secretHmac, input.authRoot.version, now, tokenExpires, emailCanonical],
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
                    id, signup_mode, paid_work_enabled, policy_version, catalog_version,
                    updated_at, max_concurrent_work
                  ) VALUES (1, ?, true, 1, 1, ?, ?)`,
            params: [input.signupMode, now, GLOBAL_PLACEHOLDER_CONCURRENCY],
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
