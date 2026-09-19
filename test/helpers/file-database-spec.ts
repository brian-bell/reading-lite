// Shared body of the two file-database isolation tests. It is run from two
// files because the property is between files: each commits the system_policy
// singleton (id = 1), the row parallel files would otherwise fight over. On a
// shared database the second file's INSERT fails on the primary key however
// the two are scheduled, so the pair cannot pass by luck.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sqlFor } from "../../src/modules/db/sql";
import { fileDatabasePrefix } from "./file-database";

export function describeFileDatabase(policyVersion: number): void {
  describe("per-file PostgreSQL database", () => {
    it("owns the system_policy singleton without colliding with a parallel file", async () => {
      const sql = sqlFor(env);
      try {
        const [{ name }] = await sql.query<{ name: string }>("SELECT current_database() AS name");
        expect(name).toContain(fileDatabasePrefix(""));

        await sql.execute(
          `INSERT INTO system_policy (id, signup_mode, paid_work_enabled, policy_version, catalog_version, updated_at)
           VALUES (1, 'open', true, $1, 1, now())`,
          [policyVersion],
        );
        expect(await sql.query("SELECT policy_version FROM system_policy")).toEqual([
          { policy_version: policyVersion },
        ]);
      } finally {
        await sql.end();
      }
    });
  });
}
