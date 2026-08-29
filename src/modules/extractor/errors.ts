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
  constructor(public readonly url: string, public readonly reason: string) {
    super(`blocked host (${reason}): ${url}`);
    this.name = "BlockedHostError";
  }
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
