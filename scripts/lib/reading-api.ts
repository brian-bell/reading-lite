// Reading API client — the operator tools' one way of speaking to the reading
// API (see CONTEXT.md "Operator surface" and bead reading-lite-gtn). The
// decoder below is the inverse of the router's `toHttp`: statuses decode back
// into the intake-outcome vocabulary instead of flattening to "error", so a
// 409 initializing owner is never miscounted as a failure.

import { EXPECTED_TENANT_HEADER, GetWhoamiResponseSchema } from "../../src/schemas/api";
import { ManifestSchema, type Manifest } from "../../src/schemas/manifest";

export type ReadingApiOutcome =
  | { kind: "activated"; id: string; attemptId?: string }
  // 200 = a settled owner. Submit/import bodies are the owner's manifest;
  // lookup bodies are id-only, so `manifest` is present only when it parses.
  | { kind: "existing"; id?: string; manifest?: Manifest }
  // 409 + id: the owner's pointer exists but its manifest isn't written yet.
  | { kind: "initializing"; id: string }
  // 409 without id: the reading can't accept this attempt right now. The
  // reason names the router's two conflict messages: an active_attempt
  // conflict means work is in flight (retryable later), a missing_markdown
  // conflict is a real failure (a force reprocess bypasses the attempt check,
  // so force callers only ever see the latter).
  | { kind: "conflict"; reason: ConflictReason; message: string }
  | { kind: "not_found" }
  // 503: a retryable service condition (queue unbound, claim contention, …).
  | { kind: "unavailable"; message: string; id?: string }
  // Client-only kinds, outside the router's intake-outcome vocabulary:
  // any status toHttp never produces (4xx auth, 5xx, malformed success).
  | { kind: "http_error"; status: number; message: string }
  // The fetch itself threw (socket closed, DNS, TLS). The request may or may
  // not have been delivered.
  | { kind: "transport_error"; message: string };

// Pure decode of an intake-route response, keyed on the wire contract of
// router.toHttp: a 409 carries `id` exactly when the owner is initializing.
export function decodeIntakeResponse(status: number, body: unknown): ReadingApiOutcome {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : undefined;

  if (status === 202) {
    if (id === undefined) {
      return { kind: "http_error", status, message: "202 response did not include an id" };
    }
    return {
      kind: "activated",
      id,
      ...(typeof b.attempt_id === "string" ? { attemptId: b.attempt_id } : {}),
    };
  }
  if (status === 200) {
    // Every valid 200 wire shape (owner manifest, lookup's id-only body)
    // carries an id; a 200 without one is a malformed response, not a success.
    if (id === undefined) {
      return { kind: "http_error", status, message: "200 response did not include an id" };
    }
    const manifest = ManifestSchema.safeParse(body);
    return {
      kind: "existing",
      id,
      ...(manifest.success ? { manifest: manifest.data } : {}),
    };
  }
  if (status === 409) {
    if (id !== undefined) return { kind: "initializing", id };
    const message = messageFrom(body, b);
    return { kind: "conflict", reason: conflictReason(message), message };
  }
  if (status === 404) return { kind: "not_found" };
  if (status === 503) {
    return {
      kind: "unavailable",
      message: messageFrom(body, b),
      ...(id === undefined ? {} : { id }),
    };
  }
  return { kind: "http_error", status, message: messageFrom(body, b) };
}

export type ConflictReason = "active_attempt" | "missing_markdown" | "unknown";

// The router's two conflict bodies (toHttp) — pinned by the contract test.
function conflictReason(message: string): ConflictReason {
  if (message === "reading already has an active attempt") return "active_attempt";
  if (message === "markdown content not available") return "missing_markdown";
  return "unknown";
}

function messageFrom(body: unknown, b: Record<string, unknown>): string {
  if (typeof b.error === "string") return b.error;
  if (typeof body === "string") return body;
  return "";
}

export type ReadingFetchOutcome =
  | { kind: "manifest"; manifest: Manifest }
  | { kind: "http_error"; status: number; message: string }
  | { kind: "transport_error"; message: string };

// GET /api/whoami: whose tenant does this bearer token act as, and is the
// tenant data-plane gate on? A 404 is significant to callers — it means the
// worker predates the endpoint — so it stays an http_error with its status.
export type WhoamiOutcome =
  | {
      kind: "identity";
      tenantId: string;
      userId: string;
      principal: "api_token" | "session";
      tenantDataPlane: boolean;
    }
  | { kind: "http_error"; status: number; message: string }
  | { kind: "transport_error"; message: string };

// Pure decode of a whoami response, parsed against the worker's own schema at
// the seam (stored-contract drift surfaces as http_error, never a bad object).
export function decodeWhoamiResponse(status: number, body: unknown): WhoamiOutcome {
  if (status !== 200) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    return { kind: "http_error", status, message: messageFrom(body, b) };
  }
  const parsed = GetWhoamiResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { kind: "http_error", status, message: "200 response was not a valid whoami body" };
  }
  return {
    kind: "identity",
    tenantId: parsed.data.tenant_id,
    userId: parsed.data.user_id,
    principal: parsed.data.principal,
    tenantDataPlane: parsed.data.tenant_data_plane,
  };
}

export type WaitTerminalOutcome =
  | { kind: "ready"; manifest: Manifest }
  | { kind: "failed"; manifest: Manifest }
  | { kind: "timeout" };

// The three-bucket view the bulk import loops report in their summaries. An
// initializing owner counts as existing — someone owns the URL and work is in
// flight — never as an error.
export interface OutcomeClassification {
  classification: "new" | "existing" | "error";
  id?: string;
  error?: string;
}

export function classifyOutcome(out: ReadingApiOutcome): OutcomeClassification {
  switch (out.kind) {
    case "activated":
      return { classification: "new", id: out.id };
    case "existing":
      return { classification: "existing", ...(out.id === undefined ? {} : { id: out.id }) };
    case "initializing":
      return { classification: "existing", id: out.id };
    case "conflict":
      return { classification: "error", error: `conflict: ${out.message}` };
    case "not_found":
      return { classification: "error", error: "not found" };
    case "unavailable":
      return { classification: "error", error: `503 ${out.message}`.trim() };
    case "http_error":
      return { classification: "error", error: `${out.status} ${out.message}`.trim() };
    case "transport_error":
      return { classification: "error", error: out.message };
  }
}

// The bulk-import commands historically take a full endpoint URL as their
// destination flag (…/api/readings). The client wants the API base; accept
// either and normalize.
export function apiBaseFromEndpoint(url: string): string {
  return url
    .replace(/\/api\/readings(\/[a-z-]*)?\/?$/i, "")
    .replace(/\/+$/, "");
}

export interface ReadingApiDeps {
  base: string;
  token: string;
  fetch: typeof fetch;
  /**
   * Layout pin sent as x-expected-tenant on every request ('global' or
   * usr_…). The worker rejects with 412 any request that would act on a
   * different layout, making a whoami preflight's verdict atomic with each
   * write instead of point-in-time. Omit for no pin.
   */
  expectedTenant?: string;
  /** Injectable for tests; drives retry backoff and waitTerminal polling. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; drives the waitTerminal deadline. */
  now?: () => number;
}

export interface ReadingApi {
  submit(url: string, opts?: { email?: boolean }): Promise<ReadingApiOutcome>;
  /**
   * Never auto-retries: a transport throw can occur after delivery, and a
   * delivered-then-retried reprocess activates (and bills) a second attempt.
   * Submit/import retries are safe because a re-request lands on the by-url
   * owner; reprocess has no such idempotency.
   */
  reprocess(
    id: string,
    opts?: { force?: boolean; email?: boolean; source?: unknown },
  ): Promise<ReadingApiOutcome>;
  importMarkdown(body: {
    source_url: string;
    markdown: string;
    title?: string;
    email?: boolean;
  }): Promise<ReadingApiOutcome>;
  /** Read-only owner resolution; an `existing`/`initializing` kind means the URL has an owner. */
  lookup(url: string): Promise<ReadingApiOutcome>;
  /** The bearer token's own tenant identity and the data-plane gate state. */
  whoami(): Promise<WhoamiOutcome>;
  /** One GET of the reading's manifest, parsed against ManifestSchema. */
  getReading(id: string): Promise<ReadingFetchOutcome>;
  /**
   * Polls getReading until the manifest is ready/failed or timeoutMs elapses.
   * Transient errors mid-poll (non-200, transport) are tolerated — the
   * deadline, not the error, decides when to give up.
   */
  waitTerminal(
    id: string,
    opts?: { pollMs?: number; timeoutMs?: number },
  ): Promise<WaitTerminalOutcome>;
}

export function readingApiFor(deps: ReadingApiDeps): ReadingApi {
  const headers = {
    authorization: `Bearer ${deps.token}`,
    "content-type": "application/json",
    ...(deps.expectedTenant === undefined
      ? {}
      : { [EXPECTED_TENANT_HEADER]: deps.expectedTenant }),
  };

  async function decodeResponse(
    res: Response,
    requireManifest: boolean,
  ): Promise<ReadingApiOutcome> {
    // A body-stream failure (socket died mid-read) is a transport failure:
    // let it throw so `request` retries the idempotent verbs.
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    const outcome = decodeIntakeResponse(res.status, body);
    if (requireManifest && outcome.kind === "existing" && outcome.manifest === undefined) {
      return {
        kind: "http_error",
        status: res.status,
        message: "200 response was not a valid manifest",
      };
    }
    return outcome;
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  // Retries transport-level throws only (undici "fetch failed" from a closed
  // keep-alive socket, edge connection cycling, …). HTTP error statuses are
  // never retried — those are the worker speaking, not a transport blip.
  // Callers opt in per verb. For submit/import a delivered-then-retried
  // request lands on the by-url owner: a pending/ready owner returns 200
  // existing, and a failed owner reprocesses in place — one extra attempt on
  // a reading whose first attempt already failed terminally, which is the
  // submitting caller's intent, not duplicated work. Reprocess has no such
  // owner convergence, hence its zero-retry invariant on the interface.
  async function request(
    url: string,
    init: RequestInit,
    retries: number,
    requireManifest = true,
  ): Promise<ReadingApiOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await decodeResponse(await deps.fetch(url, init), requireManifest);
      } catch (err) {
        if (attempt >= retries) {
          return { kind: "transport_error", message: formatFetchError(err) };
        }
        await sleep(RETRY_BASE_DELAY_MS * (1 << attempt));
      }
    }
  }

  return {
    async submit(url, opts = {}) {
      return request(
        `${deps.base}/api/readings`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            url,
            ...(opts.email === undefined ? {} : { email: opts.email }),
          }),
        },
        TRANSPORT_RETRIES,
      );
    },

    async reprocess(id, opts = {}) {
      return request(
        `${deps.base}/api/readings/${encodeURIComponent(id)}/reprocess`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            force: opts.force === true,
            ...(opts.email === undefined ? {} : { email: opts.email }),
            ...(opts.source === undefined ? {} : { source: opts.source }),
          }),
        },
        0, // see the interface note: reprocess must not auto-retry
      );
    },

    async importMarkdown(body) {
      return request(
        `${deps.base}/api/readings/import-markdown`,
        { method: "POST", headers, body: JSON.stringify(body) },
        TRANSPORT_RETRIES,
      );
    },

    async lookup(url) {
      return request(
        `${deps.base}/api/readings/lookup?url=${encodeURIComponent(url)}`,
        { headers },
        TRANSPORT_RETRIES,
        false,
      );
    },

    async whoami() {
      // Read-only and idempotent, so transport retries are safe (same
      // rationale as lookup).
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await deps.fetch(`${deps.base}/api/whoami`, { headers });
          const text = await res.text();
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            body = text;
          }
          return decodeWhoamiResponse(res.status, body);
        } catch (err) {
          if (attempt >= TRANSPORT_RETRIES) {
            return { kind: "transport_error", message: formatFetchError(err) };
          }
          await sleep(RETRY_BASE_DELAY_MS * (1 << attempt));
        }
      }
    },

    async getReading(id) {
      return getReading(id);
    },

    async waitTerminal(id, opts = {}) {
      const pollMs = opts.pollMs ?? 1_500;
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const deadline = now() + timeoutMs;
      for (;;) {
        const res = await getReading(id);
        if (res.kind === "manifest") {
          if (res.manifest.status === "ready") return { kind: "ready", manifest: res.manifest };
          if (res.manifest.status === "failed") return { kind: "failed", manifest: res.manifest };
        }
        if (now() + pollMs >= deadline) return { kind: "timeout" };
        await sleep(pollMs);
      }
    },
  };

  async function getReading(id: string): Promise<ReadingFetchOutcome> {
    let res: Response;
    let text: string;
    try {
      res = await deps.fetch(`${deps.base}/api/readings/${encodeURIComponent(id)}`, { headers });
      // A body-stream failure is a transport failure, same as a rejected fetch.
      text = await res.text();
    } catch (err) {
      return { kind: "transport_error", message: formatFetchError(err) };
    }
    if (res.status !== 200) {
      return { kind: "http_error", status: res.status, message: text.slice(0, 200) };
    }
    try {
      const manifest = ManifestSchema.parse(JSON.parse(text));
      return { kind: "manifest", manifest };
    } catch {
      return { kind: "http_error", status: 200, message: "response was not a valid manifest" };
    }
  }
}

const TRANSPORT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;

// Unwraps the cause chain so undici's opaque "fetch failed" surfaces the real
// reason (UND_ERR_SOCKET, ECONNRESET, TLS error code, etc.).
function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let cause: unknown = (err as { cause?: unknown }).cause;
  while (cause) {
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      parts.push(code ? `${code}: ${cause.message}` : cause.message);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.join(" / ");
}
