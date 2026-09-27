import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTenantId } from "../../src/control-plane/ids";
import type { Env } from "../../src/index";
import { createApp } from "../../src/router";
import {
  INBOX_ITEM_CAP,
  INBOX_STAGE_BUDGET_BYTES,
  InboxItemSchema,
  ListInboxResponseSchema,
  PostInboxExistingResponseSchema,
  PostInboxStagedResponseSchema,
} from "../../src/schemas/api";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import { testControlPlane } from "../helpers/control-plane-db";
import { readyManifest } from "../helpers/pg-fixtures";
import { insertQuotaTenant, PUBLIC_LOOKUP } from "../helpers/tenant-fixtures";
import { testReadingsFor } from "../helpers/test-readings";

function services(): Services {
  return {
    fetch: (() => {
      throw new Error("no upstream fetch on the inbox path");
    }) as unknown as typeof fetch,
    lookup: PUBLIC_LOOKUP,
    now: () => new Date().toISOString(),
    newId: mintReadingId,
  };
}

let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  send = vi.fn(async () => {});
  (env as unknown as { READING_JOBS: unknown }).READING_JOBS = { send };
});

function call(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return createApp({ services: services() }).request(
    path,
    {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
}

function stage(token: string, body: { source_url: string; markdown: string; title?: string }) {
  return call(token, "/api/inbox", { method: "POST", body });
}

async function tenant(limits: { submissions_per_hour?: number; monthly_readings?: number } = {}) {
  return insertQuotaTenant(env as unknown as Env, {
    submissions_per_hour: limits.submissions_per_hour ?? 1000,
    monthly_readings: limits.monthly_readings ?? 1000,
  });
}

function readingsOf(tenantId: string) {
  return testReadingsFor({ tenantId: parseTenantId(tenantId)! });
}

async function tableCount(table: string, tenantId: string): Promise<number> {
  const [row] = await readingsOf(tenantId).sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return row!.n;
}

describe("POST /api/inbox", () => {
  it("stages the item and nothing else: no reading, claim, attempt, job, embedding or queue message", async () => {
    const { tenantId, token } = await tenant();
    const url = "https://example.com/staged";

    const res = await stage(token, { source_url: url, markdown: "# Staged", title: "Staged" });

    expect(res.status).toBe(201);
    const body = PostInboxStagedResponseSchema.parse(await res.json());
    expect(body).toEqual({ inbox_item_id: expect.stringMatching(/^in_/), replaced: false });
    expect(send).not.toHaveBeenCalled();
    for (const table of ["readings", "reading_urls", "reading_attempts", "reading_jobs", "reading_embeddings"]) {
      expect(await tableCount(table, tenantId), table).toBe(0);
    }
    // Not in the library, and not an owner.
    const list = await call(token, "/api/readings");
    expect(((await list.json()) as { readings: unknown[] }).readings).toEqual([]);
    const lookup = await call(token, `/api/readings/lookup?url=${encodeURIComponent(url)}`);
    expect(lookup.status).toBe(404);
  });

  // Stage reserves no reading slot: with a monthly quota of one, three stages
  // still leave the slot for a submit.
  it("charges no reading quota", async () => {
    const { token } = await tenant({ monthly_readings: 1 });
    for (const n of [1, 2, 3]) {
      expect((await stage(token, { source_url: `https://example.com/q${n}`, markdown: "x" })).status).toBe(201);
    }
    const submitted = await call(token, "/api/readings", {
      method: "POST",
      body: { url: "https://example.com/submitted", email: false },
    });
    expect(submitted.status).toBe(202);
  });

  it("overwrites a re-staged URL in place and says so", async () => {
    const { token } = await tenant();
    const first = PostInboxStagedResponseSchema.parse(
      await (await stage(token, { source_url: "https://example.com/a", markdown: "first", title: "Old" })).json(),
    );

    const again = await stage(token, { source_url: "https://example.com/a", markdown: "second" });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ inbox_item_id: first.inbox_item_id, replaced: true });
    const item = InboxItemSchema.parse(await (await call(token, `/api/inbox/${first.inbox_item_id}`)).json());
    expect(item).toMatchObject({ markdown: "second", title: null });
  });

  it.each(["ready", "pending"] as const)("returns a %s owner and stages nothing", async (status) => {
    const { tenantId, token } = await tenant();
    const url = `https://example.com/owned-${status}`;
    const owner = await readyManifest("rd_OWNED0001", {
      url,
      status,
      // Fresh, so a pending owner is not stale.
      updated_at: new Date().toISOString(),
    });
    await readingsOf(tenantId).seed(owner);

    const res = await stage(token, { source_url: url, markdown: "# Duplicate" });

    expect(res.status).toBe(200);
    const body = PostInboxExistingResponseSchema.parse(await res.json());
    expect(body.reading).toMatchObject({ id: "rd_OWNED0001", status });
    expect(await tableCount("inbox_items", tenantId)).toBe(0);
  });

  it("discards an item staged before a ready owner took the URL", async () => {
    const { tenantId, token } = await tenant();
    const url = "https://example.com/owned-later";
    expect((await stage(token, { source_url: url, markdown: "# First" })).status).toBe(201);
    await readingsOf(tenantId).seed(await readyManifest("rd_LATER0001", { url }));

    const res = await stage(token, { source_url: url, markdown: "# Corrected" });

    expect(res.status).toBe(200);
    expect(PostInboxExistingResponseSchema.parse(await res.json()).reading.id).toBe("rd_LATER0001");
    expect(await tableCount("inbox_items", tenantId)).toBe(0);
  });

  it("stages for a failed owner and names it, so promote can re-import it in place", async () => {
    const { tenantId, token } = await tenant();
    const url = "https://example.com/owned-failed";
    await readingsOf(tenantId).seed(
      await readyManifest("rd_FAILED001", { url, status: "failed", error: { code: "fetch_failed", message: "no" } }),
    );

    const res = await stage(token, { source_url: url, markdown: "# Recovered" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      inbox_item_id: expect.stringMatching(/^in_/),
      replaced: false,
      corpus_reading: { id: "rd_FAILED001", status: "failed" },
    });
  });

  // Promote carries the item in one queue message, so stage measures what it
  // will carry: the body's JSON serialization in UTF-8 bytes, within the
  // 128,000-byte message less the envelope's reserve.
  const BIG = "https://example.com/big";
  function fillBudget(extraBytes: number, title?: string): string {
    const frame = new TextEncoder().encode(
      JSON.stringify({ source_url: BIG, ...(title === undefined ? {} : { title }), markdown: "" }),
    ).byteLength;
    return "a".repeat(INBOX_STAGE_BUDGET_BYTES - frame + extraBytes);
  }

  function streamed(token: string, body: string) {
    const bytes = new TextEncoder().encode(body);
    const request = new Request("http://localhost/api/inbox", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    return createApp({ services: services() }).request(request, undefined, env);
  }

  it("refuses an item that cannot fit the promote message before admitting the request", async () => {
    const { tenantId, token } = await tenant({ submissions_per_hour: 1 });

    const overs = [
      { source_url: BIG, markdown: fillBudget(1) },
      // Bytes, not characters: "é" is two bytes in UTF-8.
      { source_url: BIG, markdown: "é".repeat(63_500) },
      // JSON escaping doubles a quote: 64,000 bytes serialize to 128,000.
      { source_url: BIG, markdown: '"'.repeat(64_000) },
      // The title rides in the same message.
      { source_url: BIG, title: "T", markdown: fillBudget(0) },
    ];
    for (const body of overs) {
      const over = await stage(token, body);
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({
        error: "markdown too large",
        code: "markdown_too_large",
        limit_bytes: INBOX_STAGE_BUDGET_BYTES,
      });
    }

    // A body too large to hold an acceptable item is refused while it is
    // read, whether or not it declares a Content-Length, even when the bulk is
    // a field the schema would strip.
    const hugeBody = JSON.stringify({ source_url: BIG, markdown: "x", padding: "a".repeat(900_000) });
    const declared = await createApp({ services: services() }).request(
      "/api/inbox",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(hugeBody.length),
        },
        body: hugeBody,
      },
      env,
    );
    expect(declared.status).toBe(413);
    const undeclared = await streamed(token, hugeBody);
    expect(undeclared.status).toBe(413);

    // No refusal was charged: the one request this hour still stages, streamed.
    const atCap = await streamed(token, JSON.stringify({ source_url: BIG, markdown: fillBudget(0) }));
    expect(atCap.status).toBe(201);
    expect(await tableCount("inbox_items", tenantId)).toBe(1);
  });

  it("refuses a new URL once the inbox is full, and still overwrites a staged one", async () => {
    const { tenantId, token } = await tenant();
    const urls = Array.from({ length: INBOX_ITEM_CAP }, (_, i) => `https://seed.test/${i}`);
    await readingsOf(tenantId).sql.query(
      `INSERT INTO inbox_items (tenant_id, id, url, url_hash, markdown, created_at, updated_at)
       SELECT $1, 'in_seed' || i, url, hash, '# seeded', now(), now()
       FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS s(url, hash, i)`,
      [tenantId, urls, await Promise.all(urls.map((url) => sha256Hex(url)))],
    );

    const full = await stage(token, { source_url: "https://example.com/one-too-many", markdown: "x" });
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBeNull();
    expect(await full.json()).toEqual({ error: "inbox is full", code: "inbox_full", limit: INBOX_ITEM_CAP });

    const overwrite = await stage(token, { source_url: "https://seed.test/0", markdown: "rewritten" });
    expect(overwrite.status).toBe(200);
    expect(await tableCount("inbox_items", tenantId)).toBe(INBOX_ITEM_CAP);
  });

  it("is charged against the request rate", async () => {
    const { token } = await tenant({ submissions_per_hour: 1 });
    expect((await stage(token, { source_url: "https://example.com/r1", markdown: "x" })).status).toBe(201);

    const limited = await stage(token, { source_url: "https://example.com/r2", markdown: "x" });

    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited", limit: "request_rate" });
  });

  it("refuses a deleting account and writes nothing", async () => {
    const { tenantId, token } = await tenant();
    await testControlPlane(env as unknown as Env).run("UPDATE users SET status = 'deleting' WHERE id = ?", tenantId);

    const res = await stage(token, { source_url: "https://example.com/late", markdown: "x" });

    expect(res.status).toBe(403);
    expect(await tableCount("inbox_items", tenantId)).toBe(0);
  });

  it.each([
    ["a non-web source_url", { source_url: "ftp://example.com/a", markdown: "x" }],
    ["a title over 1000 characters", { source_url: "https://example.com/a", markdown: "x", title: "t".repeat(1001) }],
  ])("rejects a body with %s", async (_label, body) => {
    const { token } = await tenant();
    expect((await stage(token, body)).status).toBe(400);
  });
});

describe("GET and DELETE /api/inbox", () => {
  it("lists, reads and discards the tenant's own items only", async () => {
    const { token } = await tenant();
    const other = await tenant();
    const { inbox_item_id: id } = PostInboxStagedResponseSchema.parse(
      await (await stage(token, { source_url: "https://example.com/mine", markdown: "# Mine", title: "Mine" })).json(),
    );

    const list = ListInboxResponseSchema.parse(await (await call(token, "/api/inbox")).json());
    expect(list.items).toEqual([expect.objectContaining({ id, url: "https://example.com/mine", title: "Mine", markdown_bytes: 6 })]);
    expect(list.items[0]).not.toHaveProperty("markdown");
    expect(ListInboxResponseSchema.parse(await (await call(other.token, "/api/inbox")).json()).items).toEqual([]);

    expect((await call(other.token, `/api/inbox/${id}`)).status).toBe(404);
    expect((await call(other.token, `/api/inbox/${id}`, { method: "DELETE" })).status).toBe(404);

    const discarded = await call(token, `/api/inbox/${id}`, { method: "DELETE" });
    expect(discarded.status).toBe(204);
    expect((await call(token, `/api/inbox/${id}`)).status).toBe(404);
    expect((await call(token, `/api/inbox/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  // Stage and discard need readings:import; list and get need readings:read.
  it("gates writes on readings:import", async () => {
    const { tenantId, token } = await tenant();
    const { inbox_item_id: id } = PostInboxStagedResponseSchema.parse(
      await (await stage(token, { source_url: "https://example.com/scoped", markdown: "x" })).json(),
    );
    await testControlPlane(env as unknown as Env).run(
      "DELETE FROM api_token_scopes WHERE scope = 'readings:import' AND token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)",
      tenantId,
    );

    expect((await stage(token, { source_url: "https://example.com/scoped-2", markdown: "x" })).status).toBe(403);
    expect((await call(token, `/api/inbox/${id}`, { method: "DELETE" })).status).toBe(403);
    expect((await call(token, "/api/inbox")).status).toBe(200);
    expect((await call(token, `/api/inbox/${id}`)).status).toBe(200);
  });
});
