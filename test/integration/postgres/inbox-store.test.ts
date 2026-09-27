import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "../../../src/control-plane/ids";
import type { Sql } from "../../../src/modules/db/sql";
import { pgInboxStoreFor } from "../../../src/modules/stores/postgres/inbox-store";
import { INBOX_ITEM_CAP } from "../../../src/schemas/api";
import { sha256Hex } from "../../../src/services";
import { mintTenant, mintTenantWithoutUser, testSql } from "../../helpers/pg-fixtures";
import { interceptSql } from "../../helpers/sql-faults";

let sql: Sql;
beforeEach(() => {
  sql = testSql();
});
afterEach(() => sql.end());

const T0 = "2026-09-26T12:00:00.000Z";

// A clock the test moves by hand, and ids minted in sequence.
function clock(start = T0) {
  let now = start;
  let n = 0;
  return {
    now: () => now,
    newId: () => `ID${String(++n).padStart(8, "0")}`,
    set: (iso: string) => {
      now = iso;
    },
  };
}

async function seedItems(tenant: TenantContext, count: number): Promise<void> {
  const urls = Array.from({ length: count }, (_, i) => `https://seed.test/${i}`);
  const hashes = await Promise.all(urls.map((url) => sha256Hex(url)));
  await sql.query(
    `INSERT INTO inbox_items (tenant_id, id, url, url_hash, markdown, created_at, updated_at)
     SELECT $1, 'in_seed' || i, url, hash, '# seeded', $4, $4
     FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS s(url, hash, i)`,
    [String(tenant.tenantId), urls, hashes, T0],
  );
}

async function inboxRows(tenant: TenantContext): Promise<number> {
  const [row] = await sql.query<{ n: number }>("SELECT count(*)::int AS n FROM inbox_items WHERE tenant_id = $1", [
    String(tenant.tenantId),
  ]);
  return row!.n;
}

describe("PgInboxStore.stage", () => {
  it("creates an item with an in_ id and reports it was not a replacement", async () => {
    const tenant = await mintTenant();
    const inbox = pgInboxStoreFor(sql, tenant, clock());

    const out = await inbox.stage({ url: "https://example.com/a", markdown: "# A ✓", title: "A" });

    expect(out).toEqual({
      kind: "staged",
      replaced: false,
      item: {
        id: "in_ID00000001",
        url: "https://example.com/a",
        title: "A",
        markdown_bytes: 7,
        created_at: T0,
        updated_at: T0,
      },
    });
    expect(await inbox.get("in_ID00000001")).toMatchObject({ markdown: "# A ✓" });
  });

  it("overwrites a re-staged URL in place: same id, new markdown, title cleared when omitted", async () => {
    const tenant = await mintTenant();
    const time = clock();
    const inbox = pgInboxStoreFor(sql, tenant, time);
    await inbox.stage({ url: "https://example.com/a", markdown: "first", title: "Old" });
    time.set("2026-09-26T13:00:00.000Z");

    const out = await inbox.stage({ url: "https://example.com/a", markdown: "second" });

    expect(out).toMatchObject({ kind: "staged", replaced: true, item: { id: "in_ID00000001", title: null } });
    expect(await inbox.get("in_ID00000001")).toEqual({
      id: "in_ID00000001",
      url: "https://example.com/a",
      title: null,
      markdown: "second",
      markdown_bytes: 6,
      created_at: T0,
      updated_at: "2026-09-26T13:00:00.000Z",
    });
    expect(await inboxRows(tenant)).toBe(1);
  });

  // Discard takes no advisory lock, so the row a re-stage saw can be gone by
  // the time it upserts: that is a new item, and must say so.
  it("reports a new item when the staged row is discarded before the upsert", async () => {
    const tenant = await mintTenant();
    const inbox = pgInboxStoreFor(sql, tenant, clock());
    await inbox.stage({ url: "https://example.com/a", markdown: "first" });
    const other = testSql();
    const spy = interceptSql(/INSERT INTO inbox_items/, async () => {
      await pgInboxStoreFor(other, tenant, clock()).discard("in_ID00000001");
      return "pass" as const;
    });
    try {
      const out = await inbox.stage({ url: "https://example.com/a", markdown: "second" });
      expect(out).toMatchObject({ kind: "staged", replaced: false, item: { id: "in_ID00000002" } });
    } finally {
      spy.mockRestore();
      await other.end();
    }
  });

  // Promote deletes only the version it loaded, so a re-stage must always
  // move updated_at, even within the clock's millisecond.
  it("moves updated_at forward on a re-stage within the same millisecond", async () => {
    const tenant = await mintTenant();
    const inbox = pgInboxStoreFor(sql, tenant, clock());
    await inbox.stage({ url: "https://example.com/a", markdown: "first" });
    const second = await inbox.stage({ url: "https://example.com/a", markdown: "second" });
    const third = await inbox.stage({ url: "https://example.com/a", markdown: "third" });

    expect(second).toMatchObject({ item: { updated_at: "2026-09-26T12:00:00.001Z" } });
    expect(third).toMatchObject({ item: { updated_at: "2026-09-26T12:00:00.002Z" } });
  });

  it("refuses a new URL at the cap but still overwrites a staged one", async () => {
    const tenant = await mintTenant();
    await seedItems(tenant, INBOX_ITEM_CAP);
    const inbox = pgInboxStoreFor(sql, tenant, clock());

    expect(await inbox.stage({ url: "https://example.com/one-too-many", markdown: "x" })).toEqual({
      kind: "inbox_full",
    });
    expect(await inbox.stage({ url: "https://seed.test/7", markdown: "rewritten" })).toMatchObject({
      kind: "staged",
      replaced: true,
      item: { id: "in_seed8" },
    });
    expect(await inboxRows(tenant)).toBe(INBOX_ITEM_CAP);
  });

  // The users lock is shared, so it does not serialize two stages; the
  // advisory lock does. The first stage's count is held until the second
  // stage reaches its own count, or 300 ms pass: with the lock the second is
  // blocked before it can count, so the first goes on alone and commits.
  // Without it, both count 199 and both insert.
  it("admits exactly one of two concurrent new URLs at one below the cap", async () => {
    const tenant = await mintTenant();
    await seedItems(tenant, INBOX_ITEM_CAP - 1);
    let secondCounted = () => {};
    const second = new Promise<void>((resolve) => {
      secondCounted = resolve;
    });
    const spy = interceptSql(/SELECT count\(\*\)::int AS items FROM inbox_items/, async (call) => {
      if (call === 1) await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 300))]);
      else secondCounted();
      return "pass" as const;
    });
    const other = testSql();
    try {
      const outs = await Promise.all([
        pgInboxStoreFor(sql, tenant, clock()).stage({ url: "https://example.com/race-a", markdown: "a" }),
        pgInboxStoreFor(other, tenant, clock()).stage({ url: "https://example.com/race-b", markdown: "b" }),
      ]);
      expect(outs.map((out) => out.kind).sort()).toEqual(["inbox_full", "staged"]);
    } finally {
      spy.mockRestore();
      await other.end();
    }
    expect(await inboxRows(tenant)).toBe(INBOX_ITEM_CAP);
  });

  it.each([
    ["deleting", async () => {
      const tenant = await mintTenant();
      await sql.query("UPDATE users SET status = 'deleting' WHERE id = $1", [String(tenant.tenantId)]);
      return tenant;
    }],
    ["missing", async () => mintTenantWithoutUser()],
  ])("writes nothing for a tenant whose users row is %s", async (_label, makeTenant) => {
    const tenant = await makeTenant();
    const out = await pgInboxStoreFor(sql, tenant, clock()).stage({ url: "https://example.com/a", markdown: "x" });
    expect(out).toEqual({ kind: "tenant_inactive" });
    expect(await inboxRows(tenant)).toBe(0);
  });
});

describe("PgInboxStore reads and deletes", () => {
  it("lists metadata most recently staged first, scoped to the tenant", async () => {
    const tenant = await mintTenant();
    const time = clock();
    const inbox = pgInboxStoreFor(sql, tenant, time);
    await inbox.stage({ url: "https://example.com/older", markdown: "older" });
    time.set("2026-09-26T12:05:00.000Z");
    await inbox.stage({ url: "https://example.com/newer", markdown: "newer" });
    time.set("2026-09-26T12:10:00.000Z");
    // A re-stage moves the older item back to the top.
    await inbox.stage({ url: "https://example.com/older", markdown: "older, again" });
    const otherTenant = await mintTenant();
    // One clock, so the other tenant's id differs from ours.
    await pgInboxStoreFor(sql, otherTenant, time).stage({ url: "https://example.com/theirs", markdown: "x" });

    const items = await inbox.list();

    expect(items.map((item) => item.url)).toEqual(["https://example.com/older", "https://example.com/newer"]);
    expect(items[0]).not.toHaveProperty("markdown");
    expect(await pgInboxStoreFor(sql, otherTenant, time).get(items[0]!.id)).toBeNull();
  });

  it("discards an item, and reports a missing one", async () => {
    const tenant = await mintTenant();
    const inbox = pgInboxStoreFor(sql, tenant, clock());
    await inbox.stage({ url: "https://example.com/a", markdown: "x" });

    expect(await inbox.discard("in_ID00000001")).toBe(true);
    expect(await inbox.discard("in_ID00000001")).toBe(false);
    expect(await inbox.get("in_ID00000001")).toBeNull();
  });

  it("deletes only the version it was given", async () => {
    const tenant = await mintTenant();
    const time = clock();
    const inbox = pgInboxStoreFor(sql, tenant, time);
    await inbox.stage({ url: "https://example.com/a", markdown: "first" });
    time.set("2026-09-26T12:30:00.000Z");
    await inbox.stage({ url: "https://example.com/a", markdown: "second" });

    expect(await inbox.deleteIfUnchanged("in_ID00000001", T0)).toBe("changed");
    expect(await inbox.get("in_ID00000001")).toMatchObject({ markdown: "second" });
    expect(await inbox.deleteIfUnchanged("in_ID00000001", "2026-09-26T12:30:00.000Z")).toBe("deleted");
    expect(await inbox.deleteIfUnchanged("in_ID00000001", "2026-09-26T12:30:00.000Z")).toBe("missing");
  });
});
