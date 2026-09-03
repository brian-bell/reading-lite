import { z } from "zod";
import { marked } from "marked";
import type { Manifest, Connection } from "../schemas/manifest";
import type { ListIndex } from "../schemas/api";
import { fetchWithRetry, parseRateLimitDelayMs, RateLimitedError, type RetryDeps } from "./http-retry";

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export class ResendError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ResendError";
  }
}

export class BadResendResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadResendResponseError";
  }
}

export interface EmailDeps {
  fetch: typeof fetch;
  apiKey: string;
  from: string;
  to: string;
  retry?: RetryDeps;
  idempotencyKey?: string;
}

export interface SendReadingEmailInput {
  manifest: Manifest;
  webBaseUrl: string;
  listIndex: ListIndex | null;
}

export interface SendReadingEmailResult {
  id: string;
}

const ResponseSchema = z.object({ id: z.string().min(1) });

export const UNKNOWN_READING_LABEL = "(unknown reading)";

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

export function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

export function buildTitleById(listIndex: ListIndex | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!listIndex) return out;
  for (const item of listIndex.items) {
    if (item.title) out.set(item.id, item.title);
  }
  return out;
}

export async function postResendEmail(
  payload: { from: string; to: string; subject: string; html: string; text: string },
  deps: EmailDeps,
): Promise<SendReadingEmailResult> {
  const headers = new Headers({
    authorization: `Bearer ${deps.apiKey}`,
    "content-type": "application/json",
  });
  if (deps.idempotencyKey) {
    headers.set("Idempotency-Key", deps.idempotencyKey);
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  };

  const response = deps.retry
    ? await fetchWithRetry(deps.fetch, RESEND_EMAILS_URL, init, deps.retry)
    : await deps.fetch(RESEND_EMAILS_URL, init);

  if (response.status === 429) {
    const retryAfter = parseRateLimitDelayMs(response.headers, () => Date.now());
    response.body?.cancel().catch(() => {});
    throw new RateLimitedError(429, retryAfter, RESEND_EMAILS_URL);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ResendError(response.status, resendErrorMessage(body, response.status));
  }

  const json: unknown = await response.json();
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new BadResendResponseError(
      `unexpected Resend response: ${parsed.error.message}`,
    );
  }
  return { id: parsed.data.id };
}

export async function sendReadingEmail(
  input: SendReadingEmailInput,
  deps: EmailDeps,
): Promise<SendReadingEmailResult> {
  const { manifest, webBaseUrl, listIndex } = input;
  if (!manifest.title || !manifest.tldr) {
    throw new Error("sendReadingEmail: manifest must have title + tldr (status=ready)");
  }

  const detailUrl = joinUrl(webBaseUrl, `/readings/${manifest.id}`);
  const subject = manifest.title;
  const titleById = buildTitleById(listIndex);
  const html = renderHtml(manifest, detailUrl, webBaseUrl, titleById);
  const text = renderText(manifest, detailUrl, webBaseUrl, titleById);

  return postResendEmail(
    {
      from: deps.from,
      to: deps.to,
      subject,
      html,
      text,
    },
    deps,
  );
}

const SECTION_KEYS = [
  ["Tags", "tags"],
  ["Keywords", "keywords"],
  ["People", "people"],
  ["Orgs", "orgs"],
] as const;

function renderHtml(
  manifest: Manifest,
  detailUrl: string,
  webBaseUrl: string,
  titleById: Map<string, string>,
): string {
  const parts: string[] = [];
  parts.push(
    `<p><a href="${escapeAttr(manifest.url)}">${escapeText(manifest.url)}</a></p>`,
  );
  parts.push(
    `<p><a href="${escapeAttr(detailUrl)}">Open in reading-lite</a></p>`,
  );
  parts.push(`<p>${escapeText(manifest.tldr ?? "")}</p>`);

  for (const [label, key] of SECTION_KEYS) {
    const values = manifest[key] ?? [];
    if (values.length === 0) continue;
    parts.push(
      `<p><strong>${label}:</strong> ${escapeText(values.join(", "))}</p>`,
    );
  }

  const connections = manifest.connections ?? [];
  if (connections.length > 0) {
    parts.push("<p><strong>Connections:</strong></p>");
    parts.push("<ul>");
    for (const c of connections) {
      parts.push(`<li>${renderConnectionHtml(c, webBaseUrl, titleById)}</li>`);
    }
    parts.push("</ul>");
  }

  if (manifest.summary_markdown) {
    parts.push("<hr>");
    parts.push(marked.parse(manifest.summary_markdown, { async: false }) as string);
  }

  return parts.join("\n");
}

function renderConnectionHtml(
  c: Connection,
  webBaseUrl: string,
  titleById: Map<string, string>,
): string {
  const title = titleById.get(c.id);
  if (title) {
    const href = joinUrl(webBaseUrl, `/readings/${c.id}`);
    return `<a href="${escapeAttr(href)}">${escapeText(title)}</a> — ${escapeText(c.reason)}`;
  }
  return `${escapeText(UNKNOWN_READING_LABEL)} — ${escapeText(c.reason)}`;
}

function renderText(
  manifest: Manifest,
  detailUrl: string,
  webBaseUrl: string,
  titleById: Map<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`Source: ${manifest.url}`);
  lines.push(`Detail: ${detailUrl}`);
  lines.push("");
  lines.push(manifest.tldr ?? "");

  for (const [label, key] of SECTION_KEYS) {
    const values = manifest[key] ?? [];
    if (values.length === 0) continue;
    lines.push("");
    lines.push(`${label}: ${values.join(", ")}`);
  }

  const connections = manifest.connections ?? [];
  if (connections.length > 0) {
    lines.push("");
    lines.push("Connections:");
    for (const c of connections) {
      const title = titleById.get(c.id);
      if (title) {
        const href = joinUrl(webBaseUrl, `/readings/${c.id}`);
        lines.push(`- ${title} (${href}) — ${c.reason}`);
      } else {
        lines.push(`- ${UNKNOWN_READING_LABEL} — ${c.reason}`);
      }
    }
  }

  if (manifest.summary_markdown) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(manifest.summary_markdown);
  }

  return lines.join("\n");
}

function resendErrorMessage(text: string, status: number): string {
  try {
    const json = JSON.parse(text) as { message?: string; error?: { message?: string } };
    if (json.error?.message) return json.error.message;
    if (json.message) return json.message;
  } catch {
    /* ignore */
  }
  return text || `Resend returned ${status}`;
}
