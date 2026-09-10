export class FetchTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`fetch timed out after ${timeoutMs}ms: ${url}`);
    this.name = "FetchTimeoutError";
  }
}

export class OversizedResponseError extends Error {
  constructor(public readonly url: string, public readonly maxBytes: number) {
    super(`response exceeded maxBytes=${maxBytes}: ${url}`);
    this.name = "OversizedResponseError";
  }
}

export class BadStatusError extends Error {
  constructor(public readonly url: string, public readonly status: number) {
    super(`bad response status ${status}: ${url}`);
    this.name = "BadStatusError";
  }
}

export class BlockedHostError extends Error {
  readonly url: string;
  constructor(url: string, public readonly reason: string) {
    const safe = redactUrlUserinfo(url);
    super(`blocked host (${reason}): ${safe}`);
    this.name = "BlockedHostError";
    this.url = safe;
  }
}

// Credentials in a fetch_source error become durable manifest text. Strip
// WHATWG username/password when the URL parses; otherwise replace the
// userinfo@ span so an unparseable Location/start URL cannot leak a password.
export function redactUrlUserinfo(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.username === "" && parsed.password === "") return raw;
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return raw.replace(/\/\/[^/@\s]+@/g, "//[redacted]@");
  }
}

// Caption-track URLs carry expire/signature query tokens. Those must not
// become durable degradation text; keep the origin + path only.
function stripUrlQueryAndHash(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return raw.replace(/[?#][^\s]*/g, "");
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s]+/gi;

export function redactDurableErrorText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => stripUrlQueryAndHash(redactUrlUserinfo(match)));
}

export function normalizeEnrichmentError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = error.name.trim() === "" ? "unknown_error" : error.name;
    const message = redactDurableErrorText(error.message).trim();
    return { code, message: message === "" ? "unknown error" : message };
  }
  return { code: "unknown_error", message: "unknown error" };
}

// Reddit serves an HTML bot-challenge to datacenter egress, so the Worker
// cannot fetch thread JSON directly. Instead of degrading to a useless raw
// capture, fail visibly with guidance: Reddit threads are imported locally with
// the `reddit-import` skill, which fetches the public `.json` through a
// logged-in Chrome session and re-imports the markdown.
export class RedditManualImportError extends Error {
  constructor(public readonly url: string) {
    super(
      `Reddit threads can't be fetched from the worker (bot-challenge); import locally with the reddit-import skill: ${url}`,
    );
    this.name = "RedditManualImportError";
  }
}

export class XApiConfigError extends Error {
  constructor() {
    super("X_API_BEARER_TOKEN is required to import X posts.");
    this.name = "XApiConfigError";
  }
}

export class XApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
  ) {
    super(`X API request failed with status ${status}: ${endpoint}`);
    this.name = "XApiError";
  }
}

export class XThreadOutsideRecentWindowError extends Error {
  constructor() {
    super(
      "This X thread is older than the 7-day recent-search window and cannot be imported.",
    );
    this.name = "XThreadOutsideRecentWindowError";
  }
}

export class XThreadIncompleteError extends Error {
  constructor(reason: string) {
    super(`X thread could not be imported completely: ${reason}`);
    this.name = "XThreadIncompleteError";
  }
}
