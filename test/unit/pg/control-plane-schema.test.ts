import { describe, expect, it } from "vitest";
import { useRolledBackSql } from "../../helpers/pg-rollback";

// Reads the shared test database, which globalSetup has already migrated.
const sql = useRolledBackSql();

const CONTROL_PLANE_TABLES = [
  "account_deletions",
  "api_token_scopes",
  "api_tokens",
  "archive_exports",
  "auth_challenges",
  "dev_mail_outbox",
  "digest_deliveries",
  "relationship_refresh_jobs",
  "sessions",
  "signup_invites",
  "system_policy",
  "tenant_limits",
  "tenant_provider_credentials",
  "tension_refresh_jobs",
  "user_settings",
  "users",
  "wipe_progress",
];

const insertUser = (id: string, email = `${id}@test.example`) =>
  sql().query(
    `INSERT INTO users (id, email_canonical, email_display, status, created_at, updated_at)
     VALUES ($1, $2, $2, 'active', now(), now())`,
    [id, email],
  );

const insertChallenge = (id: string, state: string) =>
  sql().query(
    `INSERT INTO auth_challenges (id, purpose, email_canonical, email_display, secret_hmac, hash_key_version,
       issued_at, expires_at, state)
     VALUES ($1, 'login', 'a@test.example', 'a@test.example', $1, 1, now(), now(), $2)`,
    [id, state],
  );

describe("control-plane schema", () => {
  it("creates every control-plane table", async () => {
    const rows = await sql().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY ($1::text[])
       ORDER BY table_name COLLATE "C"`,
      [CONTROL_PLANE_TABLES],
    );
    expect(rows.map((row) => row.table_name)).toEqual(CONTROL_PLANE_TABLES);
  });

  it("keeps the control plane's foreign keys, none cascading, and gives account_deletions none", async () => {
    const rows = await sql().query(
      `SELECT c.conrelid::regclass::text AS "from", a.attname AS "column",
              c.confrelid::regclass::text AS "to", c.confdeltype AS on_delete
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY ($1::text[])
       ORDER BY c.conrelid::regclass::text COLLATE "C", a.attname`,
      [CONTROL_PLANE_TABLES],
    );
    // 'a' is NO ACTION: teardown deletes account-owned rows explicitly.
    expect(rows).toEqual([
      { from: "api_token_scopes", column: "token_id", to: "api_tokens", on_delete: "a" },
      { from: "api_tokens", column: "user_id", to: "users", on_delete: "a" },
      { from: "archive_exports", column: "tenant_id", to: "users", on_delete: "a" },
      { from: "auth_challenges", column: "user_id", to: "users", on_delete: "a" },
      { from: "digest_deliveries", column: "user_id", to: "users", on_delete: "a" },
      { from: "relationship_refresh_jobs", column: "tenant_id", to: "users", on_delete: "a" },
      { from: "sessions", column: "user_id", to: "users", on_delete: "a" },
      { from: "tenant_limits", column: "tenant_id", to: "users", on_delete: "a" },
      { from: "tenant_provider_credentials", column: "tenant_id", to: "users", on_delete: "a" },
      { from: "tension_refresh_jobs", column: "tenant_id", to: "users", on_delete: "a" },
      { from: "user_settings", column: "user_id", to: "users", on_delete: "a" },
      { from: "wipe_progress", column: "tenant_id", to: "users", on_delete: "a" },
    ]);
  });

  it("stores every timestamp as timestamptz, flags as boolean, and ceilings as bigint", async () => {
    const rows = await sql().query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY ($1::text[])`,
      [CONTROL_PLANE_TABLES],
    );
    const typeOf = (table: string, column: string) =>
      rows.find((row) => row.table_name === table && row.column_name === column)?.data_type;

    expect(rows.filter((row) => row.column_name.endsWith("_ms"))).toEqual([]);
    expect(
      rows.filter((row) => row.column_name.endsWith("_at") && row.data_type !== "timestamp with time zone"),
    ).toEqual([]);
    expect(
      rows.filter((row) => row.data_type === "boolean").map((row) => `${row.table_name}.${row.column_name}`).sort(),
    ).toEqual([
      "account_deletions.first_residue",
      "account_deletions.residue",
      "system_policy.paid_work_enabled",
      "user_settings.notify_immediate",
      "wipe_progress.first_residue",
      "wipe_progress.force",
      "wipe_progress.residue",
    ]);
    expect(typeOf("tenant_limits", "daily_spend_microdollars")).toBe("bigint");
    expect(typeOf("user_settings", "daily_spend_cap_microdollars")).toBe("bigint");
    expect(typeOf("user_settings", "summarization_effort")).toBe("text");
    expect(typeOf("tenant_provider_credentials", "ciphertext")).toBe("bytea");
    expect(typeOf("tenant_provider_credentials", "iv")).toBe("bytea");
    expect(typeOf("tenant_provider_credentials", "credential_version")).toBe("integer");
    expect(typeOf("system_policy", "daily_spend_microdollars")).toBe("bigint");
    expect(typeOf("relationship_refresh_jobs", "result_json")).toBe("jsonb");
    expect(typeOf("tension_refresh_jobs", "result_json")).toBe("jsonb");
    expect(typeOf("dev_mail_outbox", "id")).toBe("bigint");
  });

  it("pins wipe_progress's columns", async () => {
    const rows = await sql().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'wipe_progress' ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      "completed_at",
      "continuations",
      "first_completed_at",
      "first_residue",
      "force",
      "lease_seq",
      "objects_deleted",
      "phase",
      "r2_cursor",
      "residue",
      "tenant_id",
      "updated_at",
    ]);
  });

  it("defaults summarization effort to high and leaves the reader spend cap unset", async () => {
    await insertUser("usr_a");
    await sql().query(
      `INSERT INTO user_settings (
         user_id, schema_version, notify_immediate, digest_cadence,
         time_zone, digest_hour_local, digest_weekday, created_at, updated_at
       ) VALUES ('usr_a', 1, true, 'off', 'UTC', 8, 1, now(), now())`,
    );
    const [row] = await sql().query(
      `SELECT summarization_effort, daily_spend_cap_microdollars
       FROM user_settings WHERE user_id = 'usr_a'`,
    );
    expect(row).toEqual({ summarization_effort: "high", daily_spend_cap_microdollars: null });

    await sql().query(
      `UPDATE user_settings
       SET summarization_effort = 'low', daily_spend_cap_microdollars = 250000
       WHERE user_id = 'usr_a'`,
    );
    const [updated] = await sql().query(
      `SELECT summarization_effort, daily_spend_cap_microdollars
       FROM user_settings WHERE user_id = 'usr_a'`,
    );
    expect(updated).toEqual({ summarization_effort: "low", daily_spend_cap_microdollars: 250000 });
  });

  it("numbers dev mail by identity", async () => {
    const insert = () =>
      sql().query<{ id: number }>(
        "INSERT INTO dev_mail_outbox (to_email, subject, verify_url, sent_at) VALUES ('a', 's', 'u', now()) RETURNING id",
      );
    const [first] = await insert();
    const [second] = await insert();
    expect(second!.id).toBe(first!.id + 1);
  });

  it.each([
    ["a second system_policy row", "INSERT INTO system_policy (id, signup_mode, paid_work_enabled, policy_version, catalog_version, updated_at) VALUES (2, 'open', true, 1, 1, now())", /system_policy_id_check/],
    ["the retired vectors wipe phase", "INSERT INTO wipe_progress (tenant_id, phase, updated_at) VALUES ('usr_a', 'vectors', now())", /wipe_progress_phase_check/],
    ["an unknown token scope", "INSERT INTO api_token_scopes (token_id, scope) VALUES ('tok_a', 'readings:admin')", /api_token_scopes_scope_check/],
    ["an unknown archive export status", "INSERT INTO archive_exports (id, tenant_id, status, requested_at, updated_at) VALUES ('exp_a', 'usr_a', 'draft', now(), now())", /archive_exports_status_check/],
    ["a zero spend ceiling", "UPDATE system_policy SET daily_spend_microdollars = 0", /system_policy_daily_spend_microdollars_check/],
    ["a settings row for no user", "INSERT INTO user_settings (user_id, schema_version, notify_immediate, digest_cadence, time_zone, digest_hour_local, digest_weekday, created_at, updated_at) VALUES ('usr_missing', 1, true, 'off', 'UTC', 8, 1, now(), now())", /user_settings_user_id_fkey/],
    ["an unknown provider", "INSERT INTO tenant_provider_credentials (tenant_id, provider, ciphertext, iv, key_version, credential_version, last_four, status, created_at, updated_at) VALUES ('usr_a', 'gemini', '\\x00', '\\x00', 1, 1, '1234', 'active', now(), now())", /tenant_provider_credentials_provider_check/],
    ["an unknown credential status", "INSERT INTO tenant_provider_credentials (tenant_id, provider, ciphertext, iv, key_version, credential_version, last_four, status, created_at, updated_at) VALUES ('usr_a', 'openai', '\\x00', '\\x00', 1, 1, '1234', 'revoked', now(), now())", /tenant_provider_credentials_status_check/],
    ["a summarization effort outside the catalog", "INSERT INTO user_settings (user_id, schema_version, notify_immediate, digest_cadence, time_zone, digest_hour_local, digest_weekday, created_at, updated_at, summarization_effort) VALUES ('usr_a', 1, true, 'off', 'UTC', 8, 1, now(), now(), 'max')", /user_settings_summarization_effort_check/],
    ["a summarization provider with no key kind", "INSERT INTO user_settings (user_id, schema_version, notify_immediate, digest_cadence, time_zone, digest_hour_local, digest_weekday, created_at, updated_at, summarization_provider) VALUES ('usr_a', 1, true, 'off', 'UTC', 8, 1, now(), now(), 'gemini')", /user_settings_summarization_provider_check/],
    ["a zero reader spend cap", "INSERT INTO user_settings (user_id, schema_version, notify_immediate, digest_cadence, time_zone, digest_hour_local, digest_weekday, created_at, updated_at, daily_spend_cap_microdollars) VALUES ('usr_a', 1, true, 'off', 'UTC', 8, 1, now(), now(), 0)", /user_settings_daily_spend_cap_microdollars_check/],
  ])("rejects %s", async (_name, statement, constraint) => {
    await insertUser("usr_a");
    await sql().query(
      "INSERT INTO api_tokens (id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at) VALUES ('tok_a', 'usr_a', 'n', 'standard', 'schema-test-hmac', 1, now(), now())",
    );
    await sql().query(
      `INSERT INTO system_policy (id, signup_mode, paid_work_enabled, policy_version, catalog_version, updated_at)
       VALUES (1, 'open', true, 1, 1, now()) ON CONFLICT (id) DO NOTHING`,
    );
    await expect(sql().query(statement)).rejects.toThrow(constraint);
  });

  it("refuses to delete a user that still owns rows", async () => {
    await insertUser("usr_a");
    await sql().query("INSERT INTO wipe_progress (tenant_id, phase, updated_at) VALUES ('usr_a', 'done', now())");
    await expect(sql().query("DELETE FROM users WHERE id = 'usr_a'")).rejects.toThrow(/wipe_progress_tenant_id_fkey/);
  });

  it("allows one issued challenge per address and purpose, and any number of settled ones", async () => {
    await insertChallenge("ch_1", "consumed");
    await insertChallenge("ch_2", "revoked");
    await insertChallenge("ch_3", "issued");
    await expect(insertChallenge("ch_4", "issued")).rejects.toThrow(/auth_challenges_one_issued/);
  });

  it.each([
    ["a canonical email", () => insertUser("usr_b", "usr_a@test.example"), /users_email_canonical_key/],
    [
      "a token hmac",
      () =>
        sql().query(
          "INSERT INTO api_tokens (id, user_id, name, format, secret_hmac, hash_key_version, created_at, expires_at) SELECT 'tok_' || n, 'usr_a', 'n', 'standard', 'same-hmac', 1, now(), now() FROM generate_series(1, 2) n",
        ),
      /api_tokens_secret_hmac/,
    ],
    [
      "a claim id within one user",
      () =>
        sql().query(
          "INSERT INTO sessions (id, user_id, secret_hmac, hash_key_version, created_at, authenticated_at, last_seen_at, idle_expires_at, absolute_expires_at, created_from_claim_id) SELECT 'ses_' || n, 'usr_a', 'h', 1, now(), now(), now(), now(), now(), 'claim' FROM generate_series(1, 2) n",
        ),
      /sessions_user_claim/,
    ],
  ])("keeps %s unique", async (_name, duplicate, constraint) => {
    await insertUser("usr_a");
    await expect(duplicate()).rejects.toThrow(constraint);
  });
});
