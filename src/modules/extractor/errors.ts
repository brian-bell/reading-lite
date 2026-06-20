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
