import type { Reading } from "./reading";
import { sourceKnownUnavailable, type ContentProblem } from "./reading-source";

// "Open as file" in the Details section (#373; acceptance matrix: "Open
// extracted Markdown" and "Open raw capture", both "Blob in new tab",
// preserved from the SPA). The bytes come from GET /api/readings/:id/content
// and …/content/raw in the browser, on click, and open in a new tab as a
// blob: URL. They stay bytes: a capture may be a PDF or a page in a legacy
// encoding, and decoding it as text would destroy it.
//
// Two deliberate differences from the SPA. The blob is always `text/plain`:
// a blob: URL runs in the origin of the page that created it, so a raw HTML
// capture opened with its stored `text/html` type would execute the captured
// page's scripts as this app — with the session cookie, against /api/*. As
// plain text the reader sees the same bytes and nothing runs. And the tab is
// opened on the click itself, before the fetch, then pointed at the blob once
// the bytes arrive: a `window.open` after an awaited fetch is outside the
// click's activation in Safari and after a few seconds elsewhere, and is
// blocked with no way for the page to notice.

export type FileKind = "extracted" | "raw";

const FILE_PATHS: Record<FileKind, string> = {
  extracted: "content",
  raw: "content/raw",
};

export function filePath(id: string, kind: FileKind): string {
  return `/api/readings/${encodeURIComponent(id)}/${FILE_PATHS[kind]}`;
}

/** The bytes, or what the Source view would say (reading-source.ts, contentProblem). */
export type FileResult = { state: "ready"; bytes: ArrayBuffer } | ContentProblem;

/**
 * Which files to offer. The extracted Markdown follows the Source view's rule:
 * a manifest that says the source was not captured is not asked. The raw
 * capture is always offered, and a 404 says so inline — a pending or failed
 * reading may have none yet.
 */
export function offeredFiles(reading: Reading): FileKind[] {
  return sourceKnownUnavailable(reading) ? ["raw"] : ["extracted", "raw"];
}

export const FILE_LABELS: Record<FileKind, string> = {
  extracted: "Open extracted Markdown",
  raw: "Open raw capture",
};

/** The sentence shown under the buttons when a file could not be opened. */
export function fileProblem(result: ContentProblem): string {
  switch (result.state) {
    case "unavailable":
      return "That file isn't available for this reading.";
    case "forbidden":
      return "You don't have access to this reading's files.";
    case "account-changed":
      return "This tab is signed in to a different account than the page expects. Reload to continue as the account signed in now.";
  }
}

/** How long the blob URL stays valid for the new tab to load it; the SPA's own delay. */
export const REVOKE_AFTER_MS = 60_000;

/** The tab opened on the click, waiting for its file. */
export interface FileTab {
  opener: unknown;
  location: { href: string };
  close: () => void;
}

/** The part of `window` the opener touches, so tests can hand in a fake. */
export interface FileOpener {
  open: (url: string, target: string) => FileTab | null;
  URL: { createObjectURL: (blob: Blob) => string; revokeObjectURL: (url: string) => void };
  setTimeout: (handler: () => void, ms: number) => unknown;
}

/**
 * Opens the tab synchronously on the click, so the browser's pop-up rules see
 * the gesture, and severs it from this page. Null when the browser refused;
 * the browser shows its own notice for that.
 */
export function openFileTab(win: FileOpener): FileTab | null {
  const tab = win.open("", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/**
 * Points the waiting tab at the bytes as a plain-text blob, and revokes the
 * URL on a coarse delay so the tab has time to load it.
 */
export function showFile(tab: FileTab, bytes: ArrayBuffer, win: FileOpener): void {
  const blob = new Blob([bytes], { type: "text/plain; charset=utf-8" });
  const url = win.URL.createObjectURL(blob);
  tab.location.href = url;
  win.setTimeout(() => win.URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
