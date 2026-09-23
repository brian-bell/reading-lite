import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../../../src/modules/db/sql";
import { r2KeyLayout } from "../../../src/modules/stores/layout";
import { manifestToIndexItem } from "../../../src/modules/stores/list-items";
import { contentStoreFor } from "../../../src/modules/stores/content-store";
import { pgReadingStoreFor } from "../../../src/modules/stores/postgres/reading-store";
import { mintTenant, readyManifest, seedManifest, testSql } from "../../helpers/pg-fixtures";

let sql: Sql;
beforeEach(() => {
  sql = testSql();
});
afterEach(() => sql.end());

describe("PgReadingStore.listManifests", () => {
  it("returns newest first as ListIndexItems, with total_filtered across pages", async () => {
    const tenant = await mintTenant();
    const old = await readyManifest("rd_old", { created_at: "2026-01-01T00:00:00.000Z" });
    const mid = await readyManifest("rd_mid", { created_at: "2026-02-01T00:00:00.000Z" });
    const fresh = await readyManifest("rd_new", { created_at: "2026-03-01T00:00:00.000Z" });
    const prefixes = new Map<string, string>();
    for (const manifest of [mid, fresh, old]) prefixes.set(manifest.id, await seedManifest(sql, tenant, manifest));
    const store = pgReadingStoreFor(sql, tenant);

    const all = await store.listManifests({ offset: 0, limit: 10 });
    expect(all.readings).toEqual(
      [fresh, mid, old].map((manifest) => manifestToIndexItem(manifest, prefixes.get(manifest.id)!)),
    );

    const page = await store.listManifests({ offset: 1, limit: 1 });
    expect(page.readings.map((item) => item.id)).toEqual(["rd_mid"]);
    expect(page.total_filtered).toBe(3);

    const past = await store.listManifests({ offset: 5, limit: 1 });
    expect(past).toEqual({ readings: [], total_filtered: 3 });
  });

  it("breaks created_at ties by id descending", async () => {
    const tenant = await mintTenant();
    for (const id of ["rd_a", "rd_c", "rd_b"]) await seedManifest(sql, tenant, await readyManifest(id));
    const out = await pgReadingStoreFor(sql, tenant).listManifests({ offset: 0, limit: 10 });
    expect(out.readings.map((item) => item.id)).toEqual(["rd_c", "rd_b", "rd_a"]);
  });

  it.each([
    ["title, case-insensitively", "QUIET", ["rd_title"]],
    ["tldr", "harbour", ["rd_tldr"]],
    ["url", "example.org/needle", ["rd_url"]],
    ["keywords", "lighthouse", ["rd_keyword"]],
    ["surrounding whitespace trimmed", "  quiet ", ["rd_title"]],
    ["% as a literal, not a wildcard", "100%", ["rd_percent"]],
    ["_ as a literal, not a wildcard", "a_b", []],
    ["no field", "absent-everywhere", []],
  ])("q matches %s", async (_label, q, expected) => {
    const tenant = await mintTenant();
    await seedManifest(sql, tenant, await readyManifest("rd_title", { title: "A Quiet Morning" }));
    await seedManifest(sql, tenant, await readyManifest("rd_tldr", { tldr: "About a harbour town." }));
    await seedManifest(sql, tenant, await readyManifest("rd_url", { url: "https://example.org/needle" }));
    await seedManifest(sql, tenant, await readyManifest("rd_keyword", { keywords: ["Lighthouse", "sea", "salt"] }));
    await seedManifest(sql, tenant, await readyManifest("rd_percent", { title: "Up 100% this year" }));
    await seedManifest(sql, tenant, await readyManifest("rd_axb", { title: "axb" }));
    const out = await pgReadingStoreFor(sql, tenant).listManifests({ q, offset: 0, limit: 10 });
    expect(out.readings.map((item) => item.id)).toEqual(expected);
    expect(out.total_filtered).toBe(expected.length);
  });

  it.each([
    ["exact tag", "design", ["rd_tagged"]],
    ["case-insensitively on both sides", "DESIGN", ["rd_tagged"]],
    ["whole tags only", "desig", []],
  ])("tag matches %s", async (_label, tag, expected) => {
    const tenant = await mintTenant();
    await seedManifest(sql, tenant, await readyManifest("rd_tagged", { tags: ["Design", "tools"] }));
    await seedManifest(sql, tenant, await readyManifest("rd_other", { tags: ["redesign"] }));
    const out = await pgReadingStoreFor(sql, tenant).listManifests({ tag, offset: 0, limit: 10 });
    expect(out.readings.map((item) => item.id)).toEqual(expected);
    // Stored tags keep their case.
    if (expected.length > 0) expect(out.readings[0]!.tags).toEqual(["Design", "tools"]);
  });
});

describe("PgReadingStore.loadReadingById", () => {
  it("round-trips a ready manifest, ordered relationships and source_date included", async () => {
    const tenant = await mintTenant();
    const manifest = await readyManifest("rd_full", {
      source_date: "2026-03-09",
      fetched_at: "2026-04-26T19:59:00.000Z",
      novelty_verdict: "familiar",
      similarity: { count: 2, max: 0.8123456789, mean: 0.7, computed_at: "2026-04-26T20:00:00.000Z" },
      connections: [
        { id: "rd_z", reason: "first" },
        { id: "rd_a", reason: "second" },
      ],
      connections_computed_at: "2026-05-01T00:00:00.000Z",
      connections_neighbourhood_ids: ["rd_z", "rd_a", "rd_q"],
      tensions: [{ id: "rd_a", kind: "qualifies", reason: "narrows it", computed_at: "2026-05-02T00:00:00.000Z" }],
      tensions_judged: [{ id: "rd_a", judged_at: "2026-05-02T00:00:00.000Z" }],
      usage: {
        summarization: {
          provider: "openai", model: "m", input_tokens: 1, output_tokens: 2,
          reasoning_tokens: 3, cached_input_tokens: 4, cache_write_tokens: 5,
        },
        openai_embedding_tokens: 6,
      },
      last_attempt: { id: "at_1", trigger: "submit", status: "succeeded", started_at: "2026-04-26T19:58:00.000Z" },
    });
    const keyPrefix = await seedManifest(sql, tenant, manifest, { keyPrefix: "readings/imported/odd-prefix" });
    const found = await pgReadingStoreFor(sql, tenant).loadReadingById("rd_full");
    expect(found).toEqual({ keyPrefix, manifest });
  });

  it("round-trips a failed manifest without a revision", async () => {
    const tenant = await mintTenant();
    const manifest = await readyManifest("rd_failed", {
      status: "failed",
      title: undefined, tldr: undefined, tags: undefined, keywords: undefined, people: undefined,
      orgs: undefined, connections: undefined, summary_markdown: undefined,
      content_status: "failed",
      error: { code: "BadStatusError", message: "bad response status 403", stage: "fetch_source", retryable: false },
    });
    await seedManifest(sql, tenant, manifest);
    const found = await pgReadingStoreFor(sql, tenant).loadReadingById("rd_failed");
    expect(found!.manifest).toEqual(manifest);
  });

  it("returns null for an unknown id", async () => {
    expect(await pgReadingStoreFor(sql, await mintTenant()).loadReadingById("rd_missing")).toBeNull();
  });
});

describe("PgReadingStore.relationshipTargets", () => {
  it("returns list rows for the ids that exist and skips the rest", async () => {
    const tenant = await mintTenant();
    const manifest = await readyManifest("rd_target");
    const keyPrefix = await seedManifest(sql, tenant, manifest);
    await seedManifest(sql, tenant, await readyManifest("rd_unasked"));
    const store = pgReadingStoreFor(sql, tenant);
    expect(await store.relationshipTargets(["rd_target", "rd_removed"])).toEqual([
      manifestToIndexItem(manifest, keyPrefix),
    ]);
    expect(await store.relationshipTargets([])).toEqual([]);
  });
});

describe("PgReadingStore.findOwnerByUrl", () => {
  it("resolves the owning reading and ignores an orphan duplicate of the same URL", async () => {
    const tenant = await mintTenant();
    const url = "https://example.com/shared";
    await seedManifest(sql, tenant, await readyManifest("rd_owner", { url }));
    await seedManifest(sql, tenant, await readyManifest("rd_orphan", { url, status: "failed" }), { ownsUrl: false });
    const store = pgReadingStoreFor(sql, tenant);
    expect(await store.findOwnerByUrl(url)).toEqual({ id: "rd_owner", status: "ready" });
    expect(await store.findOwnerByUrl("https://example.com/unclaimed")).toBeNull();
  });

  it("is a pure SELECT: it runs inside a READ ONLY transaction", async () => {
    const tenant = await mintTenant();
    const url = "https://example.com/read-only";
    await seedManifest(sql, tenant, await readyManifest("rd_ro", { url }));
    // A Sql wraps one client, so the store's query joins this transaction.
    const owner = await sql.transaction(() => pgReadingStoreFor(sql, tenant).findOwnerByUrl(url), {
      readOnly: true,
    });
    expect(owner).toEqual({ id: "rd_ro", status: "ready" });
    // The pin is only as good as the guard: a write in the same mode fails.
    await expect(
      sql.transaction((tx) => tx.query("DELETE FROM readings WHERE tenant_id = $1", [String(tenant.tenantId)]), {
        readOnly: true,
      }),
    ).rejects.toThrow(/read-only/);
  });

  it("allows one owner per URL per tenant", async () => {
    const tenant = await mintTenant();
    const url = "https://example.com/contested";
    await seedManifest(sql, tenant, await readyManifest("rd_first", { url }));
    await expect(seedManifest(sql, tenant, await readyManifest("rd_second", { url }))).rejects.toThrow(/reading_urls_pkey/);
    // The same URL in another tenant is a different ownership row.
    await seedManifest(sql, await mintTenant(), await readyManifest("rd_first", { url }));
  });
});

describe("PgReadingStore content keys", () => {
  it("returns the revision's relative keys, and R2 serves them under the tenant root", async () => {
    const tenant = await mintTenant();
    const keyPrefix = await seedManifest(sql, tenant, await readyManifest("rd_content"));
    const keys = await pgReadingStoreFor(sql, tenant).contentKeys("rd_content");
    expect(keys).toEqual({
      rawKey: `${keyPrefix}/raw.html`,
      extractedKey: `${keyPrefix}/extracted.md`,
      contentType: "text/html; charset=utf-8",
    });

    const keyRoot = `u/${String(tenant.tenantId)}/`;
    await env.READINGS_BUCKET.put(r2KeyLayout(keyRoot).extractedKey(keyPrefix), "# Extracted", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    const content = contentStoreFor(env.READINGS_BUCKET, tenant, env);
    const object = await content.get(keys!.extractedKey!);
    expect(await object!.text()).toBe("# Extracted");
    expect(await content.get(keys!.rawKey)).toBeNull();
  });

  it("derives keys from key_prefix for a reading that was never published", async () => {
    const tenant = await mintTenant();
    const keyPrefix = await seedManifest(
      sql,
      tenant,
      await readyManifest("rd_unpublished", { status: "failed", connections: undefined, summary_markdown: undefined, content_type: "application/pdf" }),
    );
    expect(await pgReadingStoreFor(sql, tenant).contentKeys("rd_unpublished")).toEqual({
      rawKey: `${keyPrefix}/raw.pdf`,
      extractedKey: `${keyPrefix}/extracted.md`,
      contentType: "application/pdf",
    });
  });
});

describe("PgReadingStore tenant isolation", () => {
  it("never returns another tenant's rows from any method", async () => {
    const owner = await mintTenant();
    const url = "https://example.com/private";
    await seedManifest(sql, owner, await readyManifest("rd_private", { url }));
    const stranger = pgReadingStoreFor(sql, await mintTenant());
    expect(await stranger.listManifests({ offset: 0, limit: 10 })).toEqual({ readings: [], total_filtered: 0 });
    expect(await stranger.loadReadingById("rd_private")).toBeNull();
    expect(await stranger.relationshipTargets(["rd_private"])).toEqual([]);
    expect(await stranger.findOwnerByUrl(url)).toBeNull();
    expect(await stranger.contentKeys("rd_private")).toBeNull();
  });

  it("refuses a malformed tenant id before any SQL runs", () => {
    const query = vi.fn();
    const fake = { query, transaction: vi.fn(), end: vi.fn() } as unknown as Sql;
    expect(() => pgReadingStoreFor(fake, { tenantId: "usr_x' OR '1'='1" as never })).toThrow("malformed tenant id");
    expect(query).not.toHaveBeenCalled();
  });
});
