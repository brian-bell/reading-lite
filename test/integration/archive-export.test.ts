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
import { sha256Bytes } from "../../src/modules/extractor/response-bytes";
import { contentStoreFor } from "../../src/modules/stores/content-store";
import { ArchiveReportSchema } from "../../src/schemas/archive-report";
import type { Manifest } from "../../src/schemas/manifest";
import { sha256Hex } from "../../src/services";
import { expectChecksums, readZipEntries } from "../helpers/read-zip";
import { interceptSql } from "../helpers/sql-faults";
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
      "README.md",
      "checksums.sha256",
      "export.json",
      "index.json",
      "readings/rd_failed/manifest.json",
      "readings/rd_pending/manifest.json",
      "readings/rd_ready/manifest.json",
      "report.json",
    ]);
    await expectChecksums(entries);
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
    expect(dead.retry).not.toHaveBeenCalled();
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

  it("retries a dead letter when marking the export failed throws, then frees the slot", async () => {
    installQueue();
    const session = await redeemSession("clm_export_dlq_fault");
    const created = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(created.res.status).toBe(202);
    const createdBody = (await created.res.json()) as { id: string };

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fault = interceptSql(/UPDATE archive_exports\s+SET status = 'failed'/, () => new Error("database hiccup"));
    try {
      const dead = await dispatch("reading-lite-export-dlq", sent[0]);
      expect(dead.ack).not.toHaveBeenCalled();
      expect(dead.retry).toHaveBeenCalledOnce();
    } finally {
      fault.mockRestore();
      errors.mockRestore();
    }

    const stuck = await testControlPlane(env).first<{ status: string }>(
      "SELECT status FROM archive_exports WHERE id = ?",
      createdBody.id,
    );
    expect(stuck?.status).toBe("queued");
    const blocked = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(blocked.res.status).toBe(409);
    expect(await blocked.res.json()).toEqual({ error: "export_active", id: createdBody.id });

    const recovered = await dispatch("reading-lite-export-dlq", sent[0]);
    expect(recovered.ack).toHaveBeenCalledOnce();
    expect(recovered.retry).not.toHaveBeenCalled();
    const failed = await testControlPlane(env).first<{ status: string }>(
      "SELECT status FROM archive_exports WHERE id = ?",
      createdBody.id,
    );
    expect(failed?.status).toBe("failed");

    const allowed = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(allowed.res.status).toBe(202);
  });

  it("deletes a failed export's parts from the dead letter and retries when the delete throws", async () => {
    installQueue();
    const session = await redeemSession("clm_export_dlq_parts");
    const created = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(created.res.status).toBe(202);
    const { id } = (await created.res.json()) as { id: string };
    const content = contentStoreFor(env.READINGS_BUCKET, founderTenant(), env);
    // A build that wrote its parts and then kept failing before it published.
    for (const part of ["segment-0001", "central-directory"]) {
      await content.put(`exports/${id}/${part}`, new Uint8Array([1, 2, 3]), "application/octet-stream");
    }

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const deleteSpy = vi.spyOn(env.READINGS_BUCKET, "delete").mockRejectedValueOnce(new Error("r2 hiccup"));
    try {
      const dead = await dispatch("reading-lite-export-dlq", sent[0]);
      expect(dead.ack).not.toHaveBeenCalled();
      expect(dead.retry).toHaveBeenCalledOnce();
    } finally {
      deleteSpy.mockRestore();
      errors.mockRestore();
    }
    expect(await content.list(`exports/${id}`)).toHaveLength(2);

    const recovered = await dispatch("reading-lite-export-dlq", sent[0]);
    expect(recovered.ack).toHaveBeenCalledOnce();
    expect(await content.list(`exports/${id}`)).toEqual([]);
    const row = await testControlPlane(env).first<{ status: string }>(
      "SELECT status FROM archive_exports WHERE id = ?",
      id,
    );
    expect(row?.status).toBe("failed");
  });

  it("keeps a ready export's parts when a stale dead letter arrives", async () => {
    installQueue();
    const session = await redeemSession("clm_export_dlq_ready");
    const created = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(created.res.status).toBe(202);
    const { id } = (await created.res.json()) as { id: string };
    const built = await dispatch("reading-lite-export", sent[0]);
    expect(built.ack).toHaveBeenCalledOnce();
    const content = contentStoreFor(env.READINGS_BUCKET, founderTenant(), env);
    const parts = await content.list(`exports/${id}`);
    expect(parts.length).toBeGreaterThan(0);

    const dead = await dispatch("reading-lite-export-dlq", sent[0]);
    expect(dead.ack).toHaveBeenCalledOnce();
    expect(await content.list(`exports/${id}`)).toHaveLength(parts.length);
    const row = await testControlPlane(env).first<{ status: string }>(
      "SELECT status FROM archive_exports WHERE id = ?",
      id,
    );
    expect(row?.status).toBe("ready");
  });

  it("matches source counts and names every missing artifact and dangling relationship", async () => {
    installQueue();
    const readings = testReadingsFor(founderTenant());
    const readyHtml = "<article><h1>Ready</h1><p>Body</p></article>";
    const readyExtracted = "# Ready\n\nCaptured from the article.\n";
    const readyRaw = new TextEncoder().encode(readyHtml);
    const readyExtractedBytes = new TextEncoder().encode(readyExtracted);
    const gapHtml = "<p>Pending capture, extraction missing.</p>";
    const gapRaw = new TextEncoder().encode(gapHtml);
    const imported = "# Imported\n\nSupplied by the reader.\n";
    const importedRaw = new TextEncoder().encode(imported);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);

    async function reading(id: string, createdAt: string, fields: Partial<Manifest>): Promise<Manifest> {
      const url = `https://example.com/${id}`;
      return {
        id,
        url,
        url_hash: await sha256Hex(url),
        title: id,
        created_at: createdAt,
        updated_at: createdAt,
        content_type: "application/octet-stream",
        content_status: "failed",
        content_bytes: 0,
        content_sha256: "0".repeat(64),
        status: "failed",
        ...fields,
      };
    }

    await readings.seed(
      await reading("rd_readyarc", "2026-01-01T00:00:00.000Z", {
        status: "ready",
        title: "Ready article",
        tldr: "A ready article.",
        summary_markdown: "A ready article, summarized.",
        content_type: "text/html; charset=utf-8",
        content_status: "captured",
        content_bytes: readyRaw.byteLength,
        content_sha256: await sha256Bytes(readyRaw),
        extracted_bytes: readyExtractedBytes.byteLength + 3,
        connections: [
          { id: "rd_mdarc", reason: "The imported note on the same topic." },
          { id: "rd_dangling", reason: "The target is not in this library." },
        ],
        tensions: [
          {
            id: "rd_pdfarc",
            kind: "qualifies",
            reason: "The PDF narrows the claim.",
            computed_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
      { extracted: readyExtracted, raw: { ext: "html", body: readyHtml, contentType: "text/html; charset=utf-8" } },
    );
    await readings.seed(
      await reading("rd_failedarc", "2026-02-01T00:00:00.000Z", {
        status: "failed",
        title: "Failed capture",
        error: { code: "empty", message: "No content captured." },
      }),
    );
    await readings.seed(
      await reading("rd_pdfarc", "2026-03-01T00:00:00.000Z", {
        status: "ready",
        title: "A memo",
        content_type: "application/pdf",
        content_status: "raw_only",
        content_bytes: pdf.byteLength + 4,
        content_sha256: "ab".repeat(32),
      }),
      { raw: { ext: "pdf", body: pdf, contentType: "application/pdf" } },
    );
    await readings.seed(
      await reading("rd_mdarc", "2026-04-01T00:00:00.000Z", {
        status: "ready",
        source_type: "markdown",
        title: "Imported note",
        content_type: "text/markdown; charset=utf-8",
        content_status: "captured",
        content_bytes: importedRaw.byteLength,
        content_sha256: await sha256Bytes(importedRaw),
        extracted_bytes: importedRaw.byteLength,
        connections: [{ id: "rd_readyarc", reason: "The article this note cites." }],
      }),
      { extracted: imported, raw: { ext: "md", body: imported, contentType: "text/markdown; charset=utf-8" } },
    );
    await readings.seed(
      await reading("rd_gaparc", "2026-05-01T00:00:00.000Z", {
        status: "pending",
        title: "Extraction missing",
        content_type: "text/html; charset=utf-8",
        content_status: "captured",
        content_bytes: gapRaw.byteLength,
        content_sha256: await sha256Bytes(gapRaw),
      }),
      { raw: { ext: "html", body: gapHtml, contentType: "text/html; charset=utf-8" } },
    );

    const session = await redeemSession("clm_export_contents");
    const created = await request("/api/exports", { method: "POST", cookie: session.cookie, csrf: session.csrf });
    expect(created.res.status).toBe(202);
    const { id } = (await created.res.json()) as { id: string };
    const built = await dispatch("reading-lite-export", sent[0]);
    expect(built.ack).toHaveBeenCalledOnce();
    expect(built.retry).not.toHaveBeenCalled();

    const download = await request(`/api/exports/${id}/download`, { cookie: session.cookie });
    expect(download.res.status).toBe(200);
    const entries = await readZipEntries(new Uint8Array(await download.res.arrayBuffer()));
    await expectChecksums(entries);
    expect(new TextDecoder().decode(entries.get("README.md"))).toContain("format_version: 1");

    const names = [...entries.keys()].sort();
    expect(names).toEqual(
      [
        "README.md",
        "checksums.sha256",
        "export.json",
        "index.json",
        "readings/rd_failedarc/manifest.json",
        "readings/rd_gaparc/manifest.json",
        "readings/rd_gaparc/raw.html",
        "readings/rd_mdarc/extracted.md",
        "readings/rd_mdarc/manifest.json",
        "readings/rd_mdarc/raw.md",
        "readings/rd_pdfarc/manifest.json",
        "readings/rd_pdfarc/raw.pdf",
        "readings/rd_readyarc/extracted.md",
        "readings/rd_readyarc/manifest.json",
        "readings/rd_readyarc/raw.html",
        "report.json",
      ].sort(),
    );
    expect(entries.get("readings/rd_pdfarc/raw.pdf")).toEqual(pdf);
    expect(new TextDecoder().decode(entries.get("readings/rd_readyarc/extracted.md"))).toBe(readyExtracted);
    expect(new TextDecoder().decode(entries.get("readings/rd_mdarc/raw.md"))).toBe(imported);

    const stored = await testControlPlane(env).first<{ n: number }>(
      "SELECT count(*)::int AS n FROM readings WHERE tenant_id = ?",
      FOUNDER_TENANT_ID,
    );
    const index = JSON.parse(new TextDecoder().decode(entries.get("index.json"))) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(stored).toEqual({ n: index.items.length });
    expect(index.items.map((item) => item.status).sort()).toEqual(["failed", "pending", "ready", "ready", "ready"]);
    expect(names.filter((name) => name.endsWith("/manifest.json"))).toHaveLength(index.items.length);
    const document = JSON.parse(new TextDecoder().decode(entries.get("export.json"))) as {
      format_version: number;
      counts: { readings: number; pending: number; ready: number; failed: number };
    };
    expect(document).toMatchObject({ format_version: 1, counts: { readings: 5, pending: 1, ready: 3, failed: 1 } });

    const report = ArchiveReportSchema.parse(JSON.parse(new TextDecoder().decode(entries.get("report.json"))));
    expect(report.missing_artifacts).toEqual([
      { reading_id: "rd_failedarc", kind: "raw", path: "readings/rd_failedarc/raw.bin" },
      { reading_id: "rd_gaparc", kind: "extracted", path: "readings/rd_gaparc/extracted.md" },
    ]);
    expect(report.dangling_relationships).toEqual([
      { reading_id: "rd_readyarc", kind: "connection", target_id: "rd_dangling" },
    ]);
    expect(report.warnings).toEqual([
      {
        reading_id: "rd_pdfarc",
        code: "content_hash_mismatch",
        path: "readings/rd_pdfarc/raw.pdf",
        expected: "ab".repeat(32),
        actual: await sha256Bytes(pdf),
      },
      {
        reading_id: "rd_pdfarc",
        code: "content_size_mismatch",
        path: "readings/rd_pdfarc/raw.pdf",
        expected: pdf.byteLength + 4,
        actual: pdf.byteLength,
      },
      {
        reading_id: "rd_readyarc",
        code: "extracted_size_mismatch",
        path: "readings/rd_readyarc/extracted.md",
        expected: readyExtractedBytes.byteLength + 3,
        actual: readyExtractedBytes.byteLength,
      },
    ]);

    const exported = new Set(index.items.map((item) => item.id));
    for (const item of index.items) {
      const manifest = JSON.parse(new TextDecoder().decode(entries.get(`readings/${item.id}/manifest.json`))) as {
        connections?: Array<{ id: string }>;
        tensions?: Array<{ id: string }>;
      };
      for (const connection of manifest.connections ?? []) {
        const dangling = report.dangling_relationships.some(
          (gap) => gap.reading_id === item.id && gap.kind === "connection" && gap.target_id === connection.id,
        );
        expect(exported.has(connection.id)).not.toBe(dangling);
      }
      for (const tension of manifest.tensions ?? []) {
        const dangling = report.dangling_relationships.some(
          (gap) => gap.reading_id === item.id && gap.kind === "tension" && gap.target_id === tension.id,
        );
        expect(exported.has(tension.id)).not.toBe(dangling);
      }
    }
  });
});
