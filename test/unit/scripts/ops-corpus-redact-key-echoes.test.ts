// Blackbox cases for `ops corpus redact-key-echoes` (reading-lite-gh341.14):
// seed rows carrying a pre-gh341.1 key echo, run the real command against
// PostgreSQL, and assert on what the rows hold afterwards. The key pattern
// itself belongs to test/unit/modules/provider-error-text.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { corpusRedactKeyEchoesCommand } from "../../../scripts/ops-lib/commands/corpus-redact-key-echoes";
import type { TenantContext } from "../../../src/control-plane/ids";
import type { Sql } from "../../../src/modules/db/sql";
import {
  captureIo,
  operatorSession,
  seedReading,
  seedTenant,
  useCorpusDatabase,
  OPERATOR_ENV,
} from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase();

const ECHO = "Incorrect API key provided: sk-proj-****wxyz. You can find your API key at https://platform.openai.com.";
const REDACTED = "Incorrect API key provided: [redacted key]. You can find your API key at https://platform.openai.com.";
const FRAGMENT = "sk-proj-****wxyz";

let sql: Sql;
let tenant: TenantContext;

beforeEach(async () => {
  sql = sqlFor();
  tenant = await seedTenant(sql);
});

const tenantArg = (t: TenantContext = tenant): string[] => ["--tenant", String(t.tenantId)];

function deps() {
  const io = captureIo();
  const session = operatorSession(() => sql);
  return { io, session, deps: { io: io.io, openSql: session.openSql, env: { ...OPERATOR_ENV } } };
}

const keyError = (message = ECHO) => ({
  code: "OpenAIError",
  message,
  stage: "summarize" as const,
  http_status: 401,
  retryable: false,
});

async function seedFailedAttempt(readingId: string, attemptId: string, message = ECHO): Promise<void> {
  await sql.execute(
    `INSERT INTO reading_attempts (tenant_id, reading_id, id, trigger, status, stage, started_at, finished_at, error, events)
     VALUES ($1, $2, $3, 'submit', 'failed', 'summarize', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', $4::jsonb, $5::jsonb)`,
    [
      String(tenant.tenantId),
      readingId,
      attemptId,
      JSON.stringify(keyError(message)),
      JSON.stringify([
        { stage: "summarize", status: "started", at: "2026-01-01T00:00:00.000Z" },
        { stage: "summarize", status: "failed", at: "2026-01-01T00:01:00.000Z", error: keyError(message) },
      ]),
    ],
  );
}

async function storedText(readingId: string): Promise<string> {
  const [row] = await sql.query<{ reading: string; attempts: string }>(
    `SELECT (SELECT to_jsonb(r)::text FROM readings r WHERE r.tenant_id = $1 AND r.id = $2) AS reading,
            (SELECT COALESCE(jsonb_agg(to_jsonb(a))::text, '') FROM reading_attempts a
              WHERE a.tenant_id = $1 AND a.reading_id = $2) AS attempts`,
    [String(tenant.tenantId), readingId],
  );
  return `${row?.reading ?? ""}${row?.attempts ?? ""}`;
}

async function seedAffected(): Promise<void> {
  const lastAttempt = {
    id: "at_last",
    trigger: "reprocess" as const,
    status: "failed" as const,
    stage: "summarize" as const,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    error: keyError(),
  };
  // A failed reading carries it on its own error and its attempt summary; a
  // published one whose reprocess failed keeps it only in the summary.
  await seedReading(sql, tenant, "rd_failed", { status: "failed", error: keyError(), lastAttempt });
  await seedReading(sql, tenant, "rd_ready", { lastAttempt });
  await seedFailedAttempt("rd_failed", "at_old");
  await seedFailedAttempt("rd_ready", "at_old");
}

describe("ops corpus redact-key-echoes", () => {
  it("plans every affected row without changing one or printing the fragment", async () => {
    await seedAffected();
    await seedReading(sql, tenant, "rd_clean", { status: "failed", error: keyError("upstream timed out") });
    const before = await storedText("rd_failed");

    const { io, deps: d } = deps();
    expect(await corpusRedactKeyEchoesCommand.run(tenantArg(), d)).toBe(0);

    expect(JSON.parse(io.out.join("\n"))).toMatchObject({
      mode: "plan",
      readings_matched: 2,
      reading_rows_matched: 2,
      attempt_rows_matched: 2,
      rows_rewritten: 0,
      rows_remaining: 4,
    });
    expect(io.all()).toContain("rd_failed (failed) error.message");
    expect(io.all()).toContain("rd_ready attempt at_old (failed) events[1].error.message");
    expect(io.all()).not.toContain("rd_clean");
    expect(io.all()).not.toContain(FRAGMENT);
    expect(await storedText("rd_failed")).toBe(before);
  });

  it("--execute redacts the reading and its attempt history and leaves nothing to find", async () => {
    await seedAffected();
    const [{ updated_at: updatedBefore } = { updated_at: null }] = await sql.query<{ updated_at: Date }>(
      "SELECT updated_at FROM readings WHERE tenant_id = $1 AND id = 'rd_ready'",
      [String(tenant.tenantId)],
    );

    const { io, deps: d } = deps();
    expect(await corpusRedactKeyEchoesCommand.run([...tenantArg(), "--execute"], d)).toBe(0);
    expect(JSON.parse(io.out.join("\n"))).toMatchObject({ mode: "execute", rows_rewritten: 4, rows_remaining: 0 });

    for (const id of ["rd_failed", "rd_ready"]) {
      const text = await storedText(id);
      expect(text).not.toContain(FRAGMENT);
      expect(text).toContain(REDACTED);
    }
    // Nothing but the text moves: status, code and the reading's clock stay.
    const [row] = await sql.query<{ status: string; code: string; updated_at: Date }>(
      "SELECT status, last_attempt->'error'->>'code' AS code, updated_at FROM readings WHERE tenant_id = $1 AND id = 'rd_ready'",
      [String(tenant.tenantId)],
    );
    expect(row).toMatchObject({ status: "ready", code: "OpenAIError", updated_at: updatedBefore });

    const again = deps();
    expect(await corpusRedactKeyEchoesCommand.run(tenantArg(), again.deps)).toBe(0);
    expect(JSON.parse(again.io.out.join("\n"))).toMatchObject({ readings_matched: 0, rows_remaining: 0 });
  });

  it("never touches another tenant's rows", async () => {
    await seedAffected();
    const other = await seedTenant(sql);
    const before = await storedText("rd_failed");

    const { io, deps: d } = deps();
    expect(await corpusRedactKeyEchoesCommand.run([...tenantArg(other), "--execute"], d)).toBe(0);
    expect(JSON.parse(io.out.join("\n"))).toMatchObject({ readings_matched: 0, rows_rewritten: 0 });
    expect(await storedText("rd_failed")).toBe(before);
  });
});
