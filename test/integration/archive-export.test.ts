import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ARCHIVE_EXPORT_DAILY_WINDOW_MS } from "../../src/control-plane/archive-exports";
import type { ArchiveExportEnvelopeV1 } from "../../src/control-plane/export-envelope";
import { RECENT_AUTH_WINDOW_MS, SESSION_COOKIE_NAME } from "../../src/control-plane/constants";
import worker, { type Env } from "../../src/index";
import { CSRF_HEADER } from "../../src/schemas/api";
import type { MagicLinkMail } from "../../src/control-plane/magic-link-mail";
import { createApp } from "../../src/router";
import {
  FOUNDER_TENANT_ID,
  founderTenant,
  insertSecondTenant,
  otherTenant,
} from "../helpers/tenant-fixtures";
import { readZipEntries } from "../helpers/read-zip";
import { testReadingsFor } from "../helpers/test-readings";
import { testControlPlane } from "../helpers/control-plane-db";
import { toTimestamp } from "../../src/control-plane/pg-time";
import type { ListIndexItem } from "../../src/schemas/api";

const NOW = "2026-08-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const sent: ArchiveExportEnvelopeV1[] = [];

function installQueue(): void {
  sent.length = 0;
  (env as unknown as { ARCHIVE_EXPORT_JOBS: Queue<ArchiveExportEnvelopeV1> }).ARCHIVE_EXPORT_JOBS = {
    send: vi.fn(async (message: ArchiveExportEnvelopeV1) => {
      sent.push(message);
    }),
  } as unknown as Queue<ArchiveExportEnvelopeV1>;
}

function services(now = NOW) {
  return {
    fetch: globalThis.fetch,
    lookup: async () => [{ address: "93.184.216.34" }],
    now: () => now,
    newId: () => "rd_EXPORT",
  };
}

async function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    authorization?: string;
    cookie?: string;
    csrf?: string;
    now?: string;
  } = {},
) {
  const mail: MagicLinkMail[] = [];
  const app = createApp({
    services: services(init.now ?? NOW),
    auth: { sendMagicLink: async (message) => void mail.push(message) },
  });
  const ctx = createExecutionContext();
  const headers = new Headers({ origin: "http://t" });
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.csrf) headers.set(CSRF_HEADER, init.csrf);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, mail };
}

function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie");
  const match = header ? new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header) : null;
  if (!match) throw new Error("missing session cookie");
  return `${SESSION_COOKIE_NAME}=${match[1]}`;
}

async function redeemSession(redemptionId: string, email = "founder@test.example") {
  const challenge = await request("/api/auth/challenge", { method: "POST", body: { email } });
  expect(challenge.res.status).toBe(200);
  const credential = challenge.mail[0]!.verifyUrl.split("#")[1];
  if (!credential) throw new Error("missing fragment");
  const redeemed = await request("/api/auth/redeem", {
    method: "POST",
    body: { credential, redemption_id: redemptionId },
  });
  expect(redeemed.res.status).toBe(200);
  const cookie = cookieFrom(redeemed.res);
  const whoami = await request("/api/whoami", { cookie });
  const body = (await whoami.res.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
}

function listItem(id: string, status: ListIndexItem["status"], createdAt: string): ListIndexItem {
  return {
    id,
    key_prefix: `readings/${id}`,
    url: `https://example.com/${id}`,
    title: id,
    status,
    created_at: createdAt,
  };
}

async function dispatch(queue: string, body: unknown) {
  const message = { body, ack: vi.fn(), retry: vi.fn() };
  await worker.queue({ queue, messages: [message] } as unknown as MessageBatch<unknown>, env);
  return message;
}

describe("archive export", () => {
  it("lets a session download a zip of every reading status and hides it from another tenant", async () => {
    installQueue();
    await insertSecondTenant(env as unknown as Env);
    await testReadingsFor(founderTenant()).seedListItems([
      listItem("rd_pending", "pending", "2026-01-01T00:00:00.000Z"),
      listItem("rd_ready", "ready", "2026-02-01T00:00:00.000Z"),
      listItem("rd_failed", "failed", "2026-03-01T00:00:00.000Z"),
    ]);
    await testReadingsFor(otherTenant()).seedListItems([
      listItem("rd_other", "ready", "2026-04-01T00:00:00.000Z"),
    ]);
    const session = await redeemSession("clm_export_download");
    const other = await redeemSession("clm_export_other", "other@test.example");

    const missingCsrf = await request("/api/exports", { method: "POST", cookie: session.cookie });
    expect(missingCsrf.res.status).toBe(403);

    const created = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(created.res.status).toBe(202);
    const body = (await created.res.json()) as { id: string; status: string };
    expect(body.status).toBe("queued");
    expect(sent).toEqual([{ version: 1, tenantId: FOUNDER_TENANT_ID, exportId: body.id }]);

    const early = await request(`/api/exports/${body.id}/download`, { cookie: session.cookie });
    expect(early.res.status).toBe(409);
    expect(await early.res.json()).toEqual({ error: "not_ready" });

    const message = await dispatch("reading-lite-export", sent[0]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const download = await request(`/api/exports/${body.id}/download`, { cookie: session.cookie });
    expect(download.res.status).toBe(200);
    expect(download.res.headers.get("content-type")).toBe("application/zip");
    expect(download.res.headers.get("content-disposition")).toBe('attachment; filename="reading-lite-archive.zip"');
    const zip = new Uint8Array(await download.res.arrayBuffer());
    expect(download.res.headers.get("content-length")).toBe(String(zip.byteLength));
    const entries = await readZipEntries(zip);
    expect([...entries.keys()].sort()).toEqual([
      "export.json",
      "index.json",
      "readings/rd_failed/manifest.json",
      "readings/rd_pending/manifest.json",
      "readings/rd_ready/manifest.json",
    ]);
    const index = JSON.parse(new TextDecoder().decode(entries.get("index.json"))) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(index.items.map((item) => [item.id, item.status]).sort()).toEqual([
      ["rd_failed", "failed"],
      ["rd_pending", "pending"],
      ["rd_ready", "ready"],
    ]);

    const latest = await request("/api/exports/latest", { cookie: session.cookie });
    expect(latest.res.status).toBe(200);
    expect(await latest.res.json()).toMatchObject({ export: { id: body.id, status: "ready" } });

    const foreignLatest = await request("/api/exports/latest", { cookie: other.cookie });
    expect(foreignLatest.res.status).toBe(200);
    expect(await foreignLatest.res.json()).toMatchObject({ export: null });
    const foreignDownload = await request(`/api/exports/${body.id}/download`, { cookie: other.cookie });
    expect(foreignDownload.res.status).toBe(404);
  });

  it("accepts a session older than the recent-authentication window", async () => {
    installQueue();
    const session = await redeemSession("clm_export_stale");
    await testControlPlane(env).run(
      "UPDATE sessions SET authenticated_at = ? WHERE user_id = ?",
      toTimestamp(NOW_MS - RECENT_AUTH_WINDOW_MS - 60_000),
      FOUNDER_TENANT_ID,
    );
    const created = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(created.res.status).toBe(202);
  });

  it("marks the row failed when the queue rejects the send, then allows another request", async () => {
    const session = await redeemSession("clm_export_enqueue");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    (env as unknown as { ARCHIVE_EXPORT_JOBS: Queue<ArchiveExportEnvelopeV1> }).ARCHIVE_EXPORT_JOBS = {
      send: vi.fn(async () => {
        throw new Error("export queue down");
      }),
    } as unknown as Queue<ArchiveExportEnvelopeV1>;
    const failed = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(failed.res.status).toBe(503);
    errors.mockRestore();

    installQueue();
    const retry = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(retry.res.status).toBe(202);
  });

  it("refuses a bearer token on every export route", async () => {
    installQueue();
    const authorization = `Bearer ${(env as unknown as Env).READER_API_TOKEN}`;
    for (const [method, path] of [
      ["POST", "/api/exports"],
      ["GET", "/api/exports/latest"],
      ["GET", "/api/exports/exp_00000000-0000-4000-8000-000000000001/download"],
    ] as const) {
      const response = await request(path, { method, authorization });
      expect(response.res.status, `${method} ${path}`).toBe(403);
      expect(await response.res.json()).toEqual({ error: "forbidden" });
    }
    expect(sent).toEqual([]);
  });

  it("returns 409 while one is active, 429 inside the rolling day, and allows a request after failure", async () => {
    installQueue();
    const session = await redeemSession("clm_export_limits");
    const first = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(first.res.status).toBe(202);
    const firstBody = (await first.res.json()) as { id: string };

    const active = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(active.res.status).toBe(409);
    expect(await active.res.json()).toEqual({ error: "export_active", id: firstBody.id });

    const dead = await dispatch("reading-lite-export-dlq", sent[0]);
    expect(dead.ack).toHaveBeenCalledOnce();
    const failed = await testControlPlane(env).first<{ status: string }>(
      "SELECT status FROM archive_exports WHERE id = ?",
      firstBody.id,
    );
    expect(failed?.status).toBe("failed");

    const retry = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(retry.res.status).toBe(202);
    const retryBody = (await retry.res.json()) as { id: string };
    expect(retryBody.id).not.toBe(firstBody.id);
    const built = await dispatch("reading-lite-export", sent[1]);
    expect(built.ack).toHaveBeenCalledOnce();

    const limited = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(limited.res.status).toBe(429);
    expect(await limited.res.json()).toEqual({
      limit: "daily_export",
      reset_at: new Date(NOW_MS + ARCHIVE_EXPORT_DAILY_WINDOW_MS).toISOString(),
    });
  });
});
