/**
 * Multi-reading digest renderer + Resend send (issue 196 B2).
 * Titles resolve only from the caller-supplied tenant list; missing ids
 * render as "(unknown reading)". Does not consult LOCAL_MAIL_SINK or EMAIL_TO.
 */
import type { ListIndexItem } from "../schemas/api";
import {
  UNKNOWN_READING_LABEL,
  buildTitleById,
  escapeAttr,
  escapeText,
  joinUrl,
  postResendEmail,
  type EmailDeps,
  type SendReadingEmailResult,
} from "./email";

export { UNKNOWN_READING_LABEL, buildTitleById };

export interface DigestWindowBounds {
  startMs: number;
  endMs: number;
}

export interface DigestEmailInput {
  cadence: "daily" | "weekly";
  items: readonly ListIndexItem[];
  webBaseUrl: string;
  titleById: Map<string, string>;
}

export function readingEventMs(
  item: Pick<ListIndexItem, "updated_at" | "created_at">,
): number | null {
  const raw = item.updated_at ?? item.created_at;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function selectDigestReadings(
  items: readonly ListIndexItem[],
  window: DigestWindowBounds,
): ListIndexItem[] {
  const selected: Array<{ item: ListIndexItem; at: number }> = [];
  for (const item of items) {
    if (item.status !== "ready") continue;
    if (!item.title || !item.tldr) continue;
    const at = readingEventMs(item);
    if (at == null) continue;
    if (at <= window.startMs || at > window.endMs) continue;
    selected.push({ item, at });
  }
  selected.sort((a, b) => b.at - a.at || a.item.id.localeCompare(b.item.id));
  return selected.map((entry) => entry.item);
}

export function digestSubject(cadence: "daily" | "weekly", count: number): string {
  const noun = count === 1 ? "reading" : "readings";
  return `${cadence === "weekly" ? "Weekly digest" : "Daily digest"} · ${count} ${noun}`;
}

export function displayTitle(id: string, titleById: Map<string, string>): string {
  return titleById.get(id) ?? UNKNOWN_READING_LABEL;
}

export function renderDigestHtml(input: DigestEmailInput): string {
  const heading = input.cadence === "weekly" ? "Weekly digest" : "Daily digest";
  const parts: string[] = [`<h1>${heading}</h1>`];
  for (const item of input.items) {
    const title = displayTitle(item.id, input.titleById);
    const href = joinUrl(input.webBaseUrl, `/readings/${item.id}`);
    parts.push("<article>");
    parts.push(`<h2><a href="${escapeAttr(href)}">${escapeText(title)}</a></h2>`);
    parts.push(`<p>${escapeText(item.tldr ?? "")}</p>`);
    parts.push(`<p><a href="${escapeAttr(item.url)}">${escapeText(item.url)}</a></p>`);
    parts.push("</article>");
  }
  return parts.join("\n");
}

export function renderDigestText(input: DigestEmailInput): string {
  const heading = input.cadence === "weekly" ? "Weekly digest" : "Daily digest";
  const lines: string[] = [heading, ""];
  for (const item of input.items) {
    const title = displayTitle(item.id, input.titleById);
    const href = joinUrl(input.webBaseUrl, `/readings/${item.id}`);
    lines.push(title);
    lines.push(href);
    lines.push(item.tldr ?? "");
    lines.push(item.url);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function sendDigestEmail(
  input: DigestEmailInput,
  deps: EmailDeps,
): Promise<SendReadingEmailResult> {
  if (input.items.length === 0) {
    throw new Error("sendDigestEmail: refusing empty window");
  }
  return postResendEmail(
    {
      from: deps.from,
      to: deps.to,
      subject: digestSubject(input.cadence, input.items.length),
      html: renderDigestHtml(input),
      text: renderDigestText(input),
    },
    deps,
  );
}
