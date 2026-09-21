// Blackbox cases for the corpus commands that read and delete on PostgreSQL
// (reading-lite-gh347.4.7). Each one seeds real rows, runs the real command,
// and asserts on what is left — rows, bytes and exit code.
//
// The pure planners keep their own owners: classification lives in
// test/unit/corpus/audit-*, drop resolution in test/unit/corpus/drop.test.ts
// and the keeper ranking in test/unit/corpus/sweep.test.ts. Nothing here
// re-asserts them.
import { beforeEach, describe, expect, it } from "vitest";
import { corpusAuditCommand } from "../../../scripts/ops-lib/commands/corpus-audit";
import { corpusDropCommand } from "../../../scripts/ops-lib/commands/corpus-drop";
import { corpusSweepCommand } from "../../../scripts/ops-lib/commands/corpus-sweep";
import { corpusPurgeConnectionsCommand } from "../../../scripts/ops-lib/commands/corpus-purge-connections";
import { readingListCheckCommand } from "../../../scripts/ops-lib/commands/reading-list-check";
import { UsageError } from "../../../scripts/ops-lib/contract";
import type { TenantContext } from "../../../src/control-plane/ids";
import type { Sql } from "../../../src/modules/db/sql";
import {
  captureIo,
  countRows,
  memoryBucket,
  operatorSession,
  readingIds,
  keyPrefixFor,
  seedCapturingAttempt,
  seedReading,
  seedRelationship,
  seedSupersededRevision,
  seedTenant,
  unitVector,
  useCorpusDatabase,
  OPERATOR_ENV,
  type MemoryBucket,
} from "../../helpers/ops-corpus-e2e";

const sqlFor = useCorpusDatabase();

let sql: Sql;
let tenant: TenantContext;
let bucket: MemoryBucket;

beforeEach(async () => {
  sql = sqlFor();
  tenant = await seedTenant(sql);
  bucket = memoryBucket();
});

const tenantArg = (): string[] => ["--tenant", String(tenant.tenantId)];

function dropDeps() {
  const io = captureIo();
  const session = operatorSession(() => sql);
  return {
    io,
    session,
    deps: {
      io: io.io,
      r2: { deleteObject: (key: string) => bucket.deleteObject(key) },
      openSql: session.openSql,
      env: { ...OPERATOR_ENV },
    },
  };
}

describe("ops corpus drop", () => {
  it("plans without deleting a row or a byte", async () => {
    const reading = await seedReading(sql, tenant, "rd_f", { status: "failed" });
    bucket.put(`${reading.keyPrefix}/raw.html`);

    const { io, deps } = dropDeps();
    expect(await corpusDropCommand.run([...tenantArg(), "rd_f"], deps)).toBe(0);
    expect(await readingIds(sql, tenant)).toEqual(["rd_f"]);
    expect(bucket.keys()).toHaveLength(1);
    expect(io.all()).toContain("PLAN — nothing changed");
  });

  it("--execute leaves no row, no claim and no bytes", async () => {
    const reading = await seedReading(sql, tenant, "rd_f", { status: "failed" });
    bucket.put(`${reading.keyPrefix}/raw.html`);
    bucket.put(`${reading.keyPrefix}/extracted.md`);

    const { deps } = dropDeps();
    expect(await corpusDropCommand.run([...tenantArg(), "rd_f", "--execute"], deps)).toBe(0);
    expect(await readingIds(sql, tenant)).toEqual([]);
    expect(await countRows(sql, "reading_urls", tenant)).toBe(0);
    expect(bucket.keys()).toEqual([]);
  });

  it("the cascade takes the embedding, revisions and relationships with the row", async () => {
    await seedReading(sql, tenant, "rd_a", { embedding: unitVector() });
    await seedReading(sql, tenant, "rd_b");
    await seedRelationship(sql, tenant, { sourceId: "rd_a", targetId: "rd_b" });

    const { deps } = dropDeps();
    expect(
      await corpusDropCommand.run(
        [...tenantArg(), "rd_a", "--allow-ready", "--bucket", "reading-lite-staging", "--execute"],
        { ...deps, env: { ...OPERATOR_ENV, STAGING_DATABASE_URL: "postgres://test/stg" } },
      ),
    ).toBe(0);
    expect(await readingIds(sql, tenant)).toEqual(["rd_b"]);
    expect(await countRows(sql, "reading_embeddings", tenant)).toBe(0);
    expect(await countRows(sql, "reading_relationships", tenant)).toBe(0);
  });

  // The acceptance criterion the earlier attempt at this slice failed: content
  // resolves in three tiers and deletion has to cover all of them. Each case
  // fails if its tier stops being deleted.
  describe("deletes the reading's content in every contentKeys tier", () => {
    // Only a published reading has a revision, so this tier needs a ready one,
    // which means the staging-only ready path.
    it("tier 1: the current revision's keys", async () => {
      const prefix = keyPrefixFor("rd_r");
      await seedReading(sql, tenant, "rd_r", {
        revision: {
          id: "rv_1",
          rawKey: `${prefix}/revisions/rv_1/raw.html`,
          extractedKey: `${prefix}/revisions/rv_1/extracted.md`,
        },
      });
      bucket.put(`${prefix}/revisions/rv_1/raw.html`);
      bucket.put(`${prefix}/revisions/rv_1/extracted.md`);

      const { deps } = dropDeps();
      expect(
        await corpusDropCommand.run(
          [...tenantArg(), "rd_r", "--allow-ready", "--bucket", "reading-lite-staging", "--execute"],
          { ...deps, env: { ...OPERATOR_ENV, STAGING_DATABASE_URL: "postgres://test/stg" } },
        ),
      ).toBe(0);
      expect(bucket.keys()).toEqual([]);
    });

    it("tier 2: the latest capturing attempt of a reading never published", async () => {
      await seedReading(sql, tenant, "rd_c", { status: "failed" });
      const prefix = keyPrefixFor("rd_c");
      await seedCapturingAttempt(sql, tenant, "rd_c", {
        rawKey: `${prefix}/revisions/at_1/raw.html`,
        extractedKey: `${prefix}/revisions/at_1/extracted.md`,
      });
      bucket.put(`${prefix}/revisions/at_1/raw.html`);
      bucket.put(`${prefix}/revisions/at_1/extracted.md`);

      const { deps } = dropDeps();
      expect(await corpusDropCommand.run([...tenantArg(), "rd_c", "--execute"], deps)).toBe(0);
      expect(bucket.keys()).toEqual([]);
    });

    // reading_revisions accumulates one row per publish, so a reprocessed
    // reading has bytes under more than one revision prefix. Resolving only the
    // current pair leaves the earlier ones in the bucket with nothing able to
    // name them once the cascade removes their row.
    it("every revision's keys, not just the current one", async () => {
      const prefix = keyPrefixFor("rd_two");
      await seedReading(sql, tenant, "rd_two", {
        revision: {
          id: "rv_B",
          rawKey: `${prefix}/revisions/rv_B/raw.html`,
          extractedKey: `${prefix}/revisions/rv_B/extracted.md`,
        },
      });
      await seedSupersededRevision(sql, tenant, "rd_two", {
        id: "rv_A",
        rawKey: `${prefix}/revisions/rv_A/raw.html`,
        extractedKey: `${prefix}/revisions/rv_A/extracted.md`,
      });
      for (const key of [
        `${prefix}/revisions/rv_A/raw.html`,
        `${prefix}/revisions/rv_A/extracted.md`,
        `${prefix}/revisions/rv_B/raw.html`,
        `${prefix}/revisions/rv_B/extracted.md`,
      ]) bucket.put(key);

      const { deps } = dropDeps();
      expect(
        await corpusDropCommand.run(
          [...tenantArg(), "rd_two", "--allow-ready", "--bucket", "reading-lite-staging", "--execute"],
          { ...deps, env: { ...OPERATOR_ENV, STAGING_DATABASE_URL: "postgres://test/stg" } },
        ),
      ).toBe(0);
      expect(bucket.keys()).toEqual([]);
    });

    it("tier 3: the legacy spelling under the stored key_prefix", async () => {
      const reading = await seedReading(sql, tenant, "rd_l", { status: "failed" });
      bucket.put(`${reading.keyPrefix}/raw.html`);
      bucket.put(`${reading.keyPrefix}/extracted.md`);

      const { deps } = dropDeps();
      expect(await corpusDropCommand.run([...tenantArg(), "rd_l", "--execute"], deps)).toBe(0);
      expect(bucket.keys()).toEqual([]);
    });
  });

  // Deleting the row first would strand the bytes where nothing could resolve
  // them again, so a failed object delete must leave the reading visible.
  // Row first, objects second. The row delete is the half that must be atomic:
  // the reverse order could leave a live reading whose content 404s. So a
  // failed object delete still leaves the row gone, and the command says the
  // bytes are unreachable residue rather than inviting a useless re-run.
  it("still deletes the row when an object delete fails, and names the residue", async () => {
    const reading = await seedReading(sql, tenant, "rd_f", { status: "failed" });
    bucket.put(`${reading.keyPrefix}/raw.html`);
    bucket.failOn.add(`${reading.keyPrefix}/raw.html`);

    const { io, deps } = dropDeps();
    expect(await corpusDropCommand.run([...tenantArg(), "rd_f", "--execute"], deps)).toBe(1);
    expect(await readingIds(sql, tenant)).toEqual([]);
    expect(bucket.keys()).toEqual([`${reading.keyPrefix}/raw.html`]);
    expect(io.err.join("\n")).toContain("residue");
    expect(io.err.join("\n")).toContain(`${reading.keyPrefix}/raw.html`);
  });

  // Content keys come from the database now, not from the layout, so they are
  // no longer bounded by construction. A row written wrong would otherwise aim
  // the delete at an arbitrary object under the tenant root.
  it("refuses a reading whose stored content key escapes its own prefix", async () => {
    await seedReading(sql, tenant, "rd_esc", { status: "failed" });
    await seedCapturingAttempt(sql, tenant, "rd_esc", {
      rawKey: "readings/SOMEONE-ELSE/raw.html",
      extractedKey: null,
    });
    bucket.put("readings/SOMEONE-ELSE/raw.html");

    const { io, deps } = dropDeps();
    expect(await corpusDropCommand.run([...tenantArg(), "rd_esc", "--execute"], deps)).toBe(1);
    expect(bucket.keys()).toEqual(["readings/SOMEONE-ELSE/raw.html"]);
    expect(await readingIds(sql, tenant)).toEqual(["rd_esc"]);
    expect(io.err.join("\n")).toContain("fall outside");
  });

  it("refuses --allow-ready against the production bucket", async () => {
    const { deps } = dropDeps();
    await expect(
      corpusDropCommand.run([...tenantArg(), "rd_a", "--allow-ready", "--execute"], deps),
    ).rejects.toThrow(/refusing --allow-ready against production bucket/);
  });

  // --tenant global names the pre-tenant R2 layout, which has no rows. Left
  // resolvable it would read as an empty corpus rather than a wrong question.
  it("refuses --tenant global, which cannot name any row", async () => {
    const { deps } = dropDeps();
    await expect(corpusDropCommand.run(["--tenant", "global", "rd_a"], deps)).rejects.toThrow(
      /has no rows in PostgreSQL/,
    );
  });
});

describe("ops corpus sweep", () => {
  function sweepDeps() {
    const io = captureIo();
    const session = operatorSession(() => sql);
    return {
      io,
      session,
      deps: {
        io: io.io,
        r2: { deleteObject: (key: string) => bucket.deleteObject(key) },
        openSql: session.openSql,
        env: { ...OPERATOR_ENV },
      },
    };
  }

  it("keeps one survivor per group and deletes the rest, embeddings included", async () => {
    await seedReading(sql, tenant, "rd_keep", {
      url: "https://www.youtube.com/watch?v=abc",
      embedding: unitVector(),
      tldr: "a much richer summary of the video",
    });
    const dropped = await seedReading(sql, tenant, "rd_dup", {
      url: "https://youtu.be/abc",
      embedding: unitVector(),
      tldr: "thin",
    });
    bucket.put(`${dropped.keyPrefix}/raw.html`);

    const { deps } = sweepDeps();
    expect(await corpusSweepCommand.run([...tenantArg(), "--execute"], deps)).toBe(0);
    expect(await readingIds(sql, tenant)).toEqual(["rd_keep"]);
    expect(await countRows(sql, "reading_embeddings", tenant)).toBe(1);
    expect(bucket.keys()).toEqual([]);
  });

  it("plans the same groups without deleting anything", async () => {
    await seedReading(sql, tenant, "rd_keep", { url: "https://www.youtube.com/watch?v=abc" });
    await seedReading(sql, tenant, "rd_dup", { url: "https://youtu.be/abc" });

    const { io, deps } = sweepDeps();
    expect(await corpusSweepCommand.run([...tenantArg()], deps)).toBe(0);
    expect(await readingIds(sql, tenant)).toEqual(["rd_dup", "rd_keep"]);
    expect(io.all()).toContain("PLAN — nothing changed");
  });

  it("reports nothing to do on a corpus with no duplicate spellings", async () => {
    await seedReading(sql, tenant, "rd_a", { url: "https://a.example/x" });
    await seedReading(sql, tenant, "rd_b", { url: "https://b.example/y" });

    const { io, deps } = sweepDeps();
    expect(await corpusSweepCommand.run([...tenantArg(), "--execute"], deps)).toBe(0);
    expect(await readingIds(sql, tenant)).toEqual(["rd_a", "rd_b"]);
    expect(io.all()).toContain("No duplicate groups found");
  });

  it("--drop takes exactly one --keep and no other selectors", async () => {
    const { deps } = sweepDeps();
    await expect(corpusSweepCommand.run([...tenantArg(), "--drop", "rd_a"], deps)).rejects.toThrow(
      UsageError,
    );
  });

  // backfill-similarity was retired in reading-lite-gh347.4.6; a sweep must not
  // send the operator to a command that no longer exists.
  it("never recommends a retired command when a keeper is invalidated", async () => {
    await seedReading(sql, tenant, "rd_keep", {
      url: "https://www.youtube.com/watch?v=abc",
      tldr: "a much richer summary of the video",
      connections: [{ id: "rd_dup", reason: "related" }],
    });
    await seedReading(sql, tenant, "rd_dup", { url: "https://youtu.be/abc", tldr: "thin" });

    const { io, deps } = sweepDeps();
    expect(await corpusSweepCommand.run([...tenantArg(), "--execute"], deps)).toBe(0);
    expect(io.all()).not.toContain("backfill-similarity");
  });
});

describe("ops corpus purge-connections", () => {
  function purgeDeps() {
    const io = captureIo();
    const session = operatorSession(() => sql);
    return { io, session, deps: { io: io.io, openSql: session.openSql, env: { ...OPERATOR_ENV } } };
  }

  it("deletes every inbound row naming the deleted reading, and only those", async () => {
    await seedReading(sql, tenant, "rd_src");
    await seedReading(sql, tenant, "rd_other");
    await seedRelationship(sql, tenant, { sourceId: "rd_src", targetId: "rd_GNE1234567" });
    await seedRelationship(sql, tenant, { sourceId: "rd_src", targetId: "rd_other", position: 1 });

    const { io, deps } = purgeDeps();
    expect(
      await corpusPurgeConnectionsCommand.run(
        [...tenantArg(), "--id", "rd_GNE1234567", "--execute", "--sole-writer"],
        deps,
      ),
    ).toBe(0);
    expect(await countRows(sql, "reading_relationships", tenant)).toBe(1);
    expect(JSON.parse(io.out[io.out.length - 1]!)).toMatchObject({
      mode: "execute",
      relationships_matched: 1,
      relationships_deleted: 1,
    });
  });

  it("plans the same count without deleting", async () => {
    await seedReading(sql, tenant, "rd_src");
    await seedRelationship(sql, tenant, { sourceId: "rd_src", targetId: "rd_GNE1234567" });

    const { io, deps } = purgeDeps();
    expect(await corpusPurgeConnectionsCommand.run([...tenantArg(), "--id", "rd_GNE1234567"], deps)).toBe(0);
    expect(await countRows(sql, "reading_relationships", tenant)).toBe(1);
    expect(JSON.parse(io.out[io.out.length - 1]!)).toMatchObject({
      mode: "plan",
      relationships_would_delete: 1,
      relationships_deleted: 0,
    });
  });

  // Purging citations of a reading that still exists would sever live
  // connections, so absence is proved before anything is deleted.
  it("refuses while the target still exists", async () => {
    await seedReading(sql, tenant, "rd_VE12345678");
    await seedReading(sql, tenant, "rd_src");
    await seedRelationship(sql, tenant, { sourceId: "rd_src", targetId: "rd_VE12345678" });

    const { io, deps } = purgeDeps();
    expect(
      await corpusPurgeConnectionsCommand.run(
        [...tenantArg(), "--id", "rd_VE12345678", "--execute", "--sole-writer"],
        deps,
      ),
    ).toBe(1);
    expect(await countRows(sql, "reading_relationships", tenant)).toBe(1);
    expect(JSON.parse(io.out[io.out.length - 1]!)).toMatchObject({ failure_code: "target_present" });
  });

  // Both kinds dangle identically when their target is deleted, and both live
  // in one table. Tensions cost provider spend, so the count is reported rather
  // than removed silently.
  it("deletes inbound tensions too, and reports how many", async () => {
    await seedReading(sql, tenant, "rd_src");
    await seedRelationship(sql, tenant, { sourceId: "rd_src", targetId: "rd_GNE1234567" });
    await seedRelationship(sql, tenant, {
      sourceId: "rd_src",
      targetId: "rd_GNE1234567",
      kind: "tension",
    });

    const { io, deps } = purgeDeps();
    expect(
      await corpusPurgeConnectionsCommand.run(
        [...tenantArg(), "--id", "rd_GNE1234567", "--execute", "--sole-writer"],
        deps,
      ),
    ).toBe(0);
    expect(await countRows(sql, "reading_relationships", tenant)).toBe(0);
    expect(JSON.parse(io.out[io.out.length - 1]!)).toMatchObject({
      relationships_deleted: 2,
      tensions_matched: 1,
    });
    expect(io.err.join("\n")).toContain("judged tensions");
  });

  // Quiescence is asserted, not inferred: no single statement can exclude a
  // publisher whose transaction opened before the DELETE.
  it("refuses --execute without --sole-writer, before connecting", async () => {
    const { io, session, deps } = purgeDeps();
    await expect(
      corpusPurgeConnectionsCommand.run([...tenantArg(), "--id", "rd_GNE1234567", "--execute"], deps),
    ).rejects.toThrow(/--execute requires --sole-writer/);
    expect(session.urls()).toEqual([]);
    expect(io.err.join("\n")).toContain("REFUSED");
  });

  // The recount is a check on that assertion, not a replacement for it: it
  // catches a publisher that committed between the DELETE and the read, so an
  // operator who asserted a quiescence that did not hold is told so rather than
  // handed a clean audit.
  it("reports a relationship that a concurrent publisher committed after the delete", async () => {
    await seedReading(sql, tenant, "rd_src");
    await seedReading(sql, tenant, "rd_late");
    await seedRelationship(sql, tenant, { sourceId: "rd_src", targetId: "rd_GNE1234567" });

    const io = captureIo();
    let raced = false;
    const deps = {
      io: io.io,
      openSql: () => ({
        ...sql,
        end: async () => {},
        // Stand in for a publisher whose transaction commits between the
        // DELETE and the verification read.
        execute: async (text: string, ...params: unknown[]) => {
          const removed = await sql.execute(text, ...(params as never[]));
          if (!raced && text.includes("DELETE FROM reading_relationships")) {
            raced = true;
            await seedRelationship(sql, tenant, {
              sourceId: "rd_late",
              targetId: "rd_GNE1234567",
            });
          }
          return removed;
        },
      }),
      env: { ...OPERATOR_ENV },
    };

    expect(
      await corpusPurgeConnectionsCommand.run(
        [...tenantArg(), "--id", "rd_GNE1234567", "--execute", "--sole-writer"],
        deps,
      ),
    ).toBe(1);
    expect(JSON.parse(io.out[io.out.length - 1]!)).toMatchObject({
      relationships_deleted: 1,
      relationships_remaining: 1,
      failure_code: "concurrent_writer",
    });
    expect(io.err.join("\n")).toContain("re-run");
  });

  it("refuses a malformed target id before connecting", async () => {
    const { io, session, deps } = purgeDeps();
    expect(await corpusPurgeConnectionsCommand.run([...tenantArg(), "--id", "nope"], deps)).toBe(2);
    expect(session.urls()).toEqual([]);
    expect(JSON.parse(io.out[io.out.length - 1]!)).toMatchObject({ failure_code: "invalid_target" });
  });
});

describe("ops corpus audit", () => {
  function auditDeps(now = Date.parse("2026-03-01T00:00:00.000Z")) {
    const io = captureIo();
    const session = operatorSession(() => sql);
    const written = new Map<string, string>();
    return {
      io,
      session,
      written,
      deps: {
        io: io.io,
        r2: { readObject: (key: string) => bucket.readObject(key) },
        openSql: session.openSql,
        env: { ...OPERATOR_ENV },
        mkdir: async () => {},
        writeFile: async (path: string, body: string) => { written.set(path, body); },
        now: () => now,
      },
    };
  }

  it("inventories the tenant's non-ready readings without writing in plan mode", async () => {
    await seedReading(sql, tenant, "rd_ok");
    await seedReading(sql, tenant, "rd_bad", {
      status: "failed",
      url: "https://a.example/bad",
      error: { code: "fetch_failed", message: "403" },
    });

    const { io, written, deps } = auditDeps();
    expect(await corpusAuditCommand.run([...tenantArg()], deps)).toBe(0);
    expect(written.size).toBe(0);
    expect(io.all()).toContain('"failed": 1');
    expect(io.all()).toContain('"ready": 1');
  });

  it("--execute writes both reports, stamped with the tenant it read", async () => {
    await seedReading(sql, tenant, "rd_bad", {
      status: "failed",
      error: { code: "fetch_failed", message: "403" },
    });

    const { written, deps } = auditDeps();
    expect(await corpusAuditCommand.run([...tenantArg(), "--out", "/tmp/audit", "--execute"], deps)).toBe(0);
    const index = JSON.parse(written.get("/tmp/audit/index.json")!);
    expect(index.tenant).toBe(String(tenant.tenantId));
    expect(index.rows.map((r: { reading_id: string }) => r.reading_id)).toEqual(["rd_bad"]);
    expect(written.has("/tmp/audit/INDEX.md")).toBe(true);
  });

  it("never reports another tenant's corpus", async () => {
    const other = await seedTenant(sql);
    await seedReading(sql, other, "rd_theirs", { status: "failed" });
    await seedReading(sql, tenant, "rd_mine", { status: "failed" });

    const { written, deps } = auditDeps();
    expect(await corpusAuditCommand.run([...tenantArg(), "--out", "/tmp/a2", "--execute"], deps)).toBe(0);
    const index = JSON.parse(written.get("/tmp/a2/index.json")!);
    expect(index.rows.map((r: { reading_id: string }) => r.reading_id)).toEqual(["rd_mine"]);
  });
});

// One loop rather than a case per command: the session is opened and closed in
// one place (withOperatorSql), so what needs pinning is that every command that
// opens one goes through it — on the way out of a success and of a failure
// alike. A command that returned without closing would leak the socket.
describe("every command that opens a session closes it", () => {
  const commands = [
    { name: "corpus audit", run: (deps: never) => corpusAuditCommand.run(tenantArg(), deps) },
    { name: "corpus drop", run: (deps: never) => corpusDropCommand.run([...tenantArg(), "rd_a"], deps) },
    { name: "corpus sweep", run: (deps: never) => corpusSweepCommand.run(tenantArg(), deps) },
    {
      name: "corpus purge-connections",
      run: (deps: never) =>
        corpusPurgeConnectionsCommand.run([...tenantArg(), "--id", "rd_GNE1234567"], deps),
    },
    {
      name: "reading-list check",
      run: (deps: never) => readingListCheckCommand.run([...tenantArg(), "--file", "l.json"], deps),
    },
  ];

  function depsFor(failing: boolean) {
    const io = captureIo();
    const session = operatorSession(() =>
      failing
        ? ({ ...sql, query: async () => { throw new Error("connection reset"); } } as Sql)
        : sql,
    );
    return {
      session,
      deps: {
        io: io.io,
        r2: { deleteObject: (k: string) => bucket.deleteObject(k), readObject: (k: string) => bucket.readObject(k) },
        openSql: session.openSql,
        env: { ...OPERATOR_ENV },
        readFile: async () => "[]",
        writeFileAtomic: async () => {},
        mkdir: async () => {},
        writeFile: async () => {},
        now: () => Date.parse("2026-03-01T00:00:00.000Z"),
      } as never,
    };
  }

  it.each(commands)("$name closes its session when the work succeeds", async ({ run }) => {
    const { session, deps } = depsFor(false);
    await run(deps).catch(() => undefined);
    expect(session.ended()).toBe(1);
  });

  it.each(commands)("$name closes its session when the work throws", async ({ run }) => {
    const { session, deps } = depsFor(true);
    await run(deps).catch(() => undefined);
    expect(session.ended()).toBe(1);
  });
});

describe("ops reading-list check", () => {
  function checkDeps(file: string) {
    const io = captureIo();
    const session = operatorSession(() => sql);
    const written = new Map<string, string>();
    return {
      io,
      written,
      deps: {
        io: io.io,
        readFile: async () => file,
        writeFileAtomic: async (path: string, body: string) => { written.set(path, body); },
        openSql: session.openSql,
        env: { ...OPERATOR_ENV },
      },
    };
  }

  // The regression this command's silence caused: every saved URL came back
  // unprocessed, and reading-list process would resubmit the whole corpus.
  it("marks a URL the tenant already owns as processed", async () => {
    await seedReading(sql, tenant, "rd_a", { url: "https://a.example/one" });
    const file = JSON.stringify([{ url: "https://a.example/one" }, { url: "https://b.example/two" }]);

    const { io, deps } = checkDeps(file);
    expect(await readingListCheckCommand.run([...tenantArg(), "--file", "list.json"], deps)).toBe(0);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ processed: 1, unprocessed: 1 });
  });

  it("counts only the statuses asked for", async () => {
    await seedReading(sql, tenant, "rd_p", { url: "https://a.example/one", status: "pending" });
    const file = JSON.stringify([{ url: "https://a.example/one" }]);

    const ready = checkDeps(file);
    expect(await readingListCheckCommand.run([...tenantArg(), "--file", "l.json"], ready.deps)).toBe(0);
    expect(JSON.parse(ready.io.out[0]!)).toMatchObject({ processed: 0 });

    const any = checkDeps(file);
    expect(
      await readingListCheckCommand.run([...tenantArg(), "--file", "l.json", "--any-status"], any.deps),
    ).toBe(0);
    expect(JSON.parse(any.io.out[0]!)).toMatchObject({ processed: 1 });
  });

  it("--execute writes the annotated list; plan mode does not", async () => {
    await seedReading(sql, tenant, "rd_a", { url: "https://a.example/one" });
    const file = JSON.stringify([{ url: "https://a.example/one" }]);

    const plan = checkDeps(file);
    expect(await readingListCheckCommand.run([...tenantArg(), "--file", "l.json"], plan.deps)).toBe(0);
    expect(plan.written.size).toBe(0);

    const exec = checkDeps(file);
    expect(
      await readingListCheckCommand.run([...tenantArg(), "--file", "l.json", "--execute"], exec.deps),
    ).toBe(0);
    expect(JSON.parse([...exec.written.values()][0]!)[0]).toMatchObject({ processed: true });
  });
});
