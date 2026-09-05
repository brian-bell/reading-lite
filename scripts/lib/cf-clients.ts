import { parseRestListPage, parseS3ListPage, nextListToken } from "./r2-list-pages";
import { AwsClient } from "aws4fetch";
import { parseRateLimitDelayMs } from "../../src/modules/http-retry";

// Shared Cloudflare clients for the Node bulk scripts (corpus-recover
// --batch). R2 over the S3 API (SigV4 via aws4fetch); Vectorize over the REST
// API. fetch is injected (default: global) so tests stub it — no globals reached
// for inside the factory.

export interface R2PutOptions {
  contentType?: string;
}

export interface R2Client {
  put(key: string, body: Uint8Array | string, opts?: R2PutOptions): Promise<void>;
  putIfAbsent(key: string, body: Uint8Array | string, opts?: R2PutOptions): Promise<boolean>;
  putIfMatch?(key: string, body: Uint8Array | string, etag: string, opts?: R2PutOptions): Promise<boolean>;
  get(key: string): Promise<string | null>;
  head(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

export interface R2ObjectMeta {
  key: string;
  size: number;
  // The S3 ETag with its surrounding quotes stripped. For single-part objects
  // (everything this corpus writes) it is the content MD5, so source/dest
  // equality is a byte-identity check.
  etag: string;
  // ISO-8601 upload time as the storage API reports it, when it reports one.
  // Optional because the many in-memory listing fakes predate it and because
  // nothing in the copy/inventory paths depends on it — `ops account
  // sweep-wipe-prefix` prints it so an operator can see the age of an orphaned
  // record before deleting it.
  lastModified?: string;
}

export interface R2ObjectBody {
  body: Uint8Array;
  contentType: string | null;
}

// A text read that also carries the object's ETag, so a caller that needs a
// CAS token gets it from the GET response instead of a second LIST request.
export interface R2ObjectText {
  body: string;
  // The ETag with its quotes and any weak-validator prefix stripped, matching
  // R2ObjectMeta.etag, so a value from either surface works with putIfMatch.
  etag: string;
}

// Inventory-grade operations: size/etag listings for exact repair plans and
// byte-faithful reads
// for binary-safe copies. A separate interface so the many in-memory R2Client
// fakes in tests keep compiling; makeR2Client always returns the superset.
export interface R2InventoryClient extends R2Client {
  putIfMatch(key: string, body: Uint8Array | string, etag: string, opts?: R2PutOptions): Promise<boolean>;
  listObjects(prefix?: string): Promise<R2ObjectMeta[]>;
  getBytes(key: string): Promise<R2ObjectBody | null>;
  getWithEtag(key: string): Promise<R2ObjectText | null>;
}

export interface VectorizeUpsertVector {
  id: string;
  values: number[];
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorizeClient {
  upsert(vectors: VectorizeUpsertVector[]): Promise<void>;
  query(
    vector: number[],
    opts: { topK: number; returnMetadata?: boolean },
  ): Promise<VectorizeMatch[]>;
}

export interface StoredVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
  namespace?: string;
}

// Administrative operations: fetch stored vectors by id for auditing and
// repair without a paid re-embed. get_by_ids addresses vectors by their
// index-unique id regardless of namespace, which is exactly what lets one
// call probe legacy (bare-id) and migrated (tenant-prefixed) vectors at once.
export interface VectorizeAdminClient extends VectorizeClient {
  getByIds(ids: string[]): Promise<StoredVector[]>;
  /**
   * Query by a vector the index already holds, addressed by id — the same
   * single POST `wrangler vectorize query --vector-id` makes (verified against
   * wrangler 4.101's queryIndexByVectorId). No embedding call, so no spend and
   * no risk of a freshly-computed vector drifting from the indexed one.
   *
   * An id the index does not hold is NOT an error: the API answers 200 with an
   * empty match list, and so does a namespaced query for a vector that lives in
   * another namespace. A present vector always matches itself, so "no matches"
   * is the missing-vector signal — the same one wrangler prints as "Could not
   * find any relevant vectors" on a zero exit.
   */
  queryById(
    id: string,
    opts: { topK: number; returnMetadata?: boolean },
  ): Promise<VectorizeMatch[]>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface R2RestConfig {
  accountId: string;
  apiToken: string;
  bucket: string;
}

export interface VectorizeConfig {
  accountId: string;
  index: string;
  apiToken: string;
  /**
   * Tenant namespace for every upsert and query (reading-lite-s1k.4.3),
   * matching the worker's similarityStoreFor. Omit for the global,
   * pre-tenant namespace.
   */
  namespace?: string;
}

// A refresh pass is thousands of sequential S3 requests, so both halves of
// this matter: without a deadline one stalled connection blocks the whole loop
// for as long as the OS keeps the socket open (a refresh run has hung this
// way), and without a retry one transient read ends the command with exit 1.
//
// Both are opt-in, and only the corpus refresh commands opt in
// (refreshS3RequestDeps below). A client built without them behaves exactly as
// it always has: one attempt, no deadline. The bulk ingest, recover, migrate,
// purge and teardown commands move objects on their own schedules and were
// never the subject of this measurement, so they keep the behaviour they were
// written and run against.
//
// Every attempt gets a fresh deadline, and the request is re-signed each time
// because a SigV4 signature carries the timestamp it was made at.
//
// Conditional PUTs are the exception: they are NOT retried. A putIfAbsent or
// putIfMatch whose response was lost may already have landed, and the retry
// then sees its own write and returns false — "already owned" for the by-url
// ownership claim, "CAS lost" for a manifest. Callers read that as someone
// else holding the slot, which for the claim means an orphan pointer owning a
// URL no reading was activated for. A thrown transient error is the honest
// outcome there, and it is what these callers already handled. Everything
// else — reads, listings, plain puts, deletes — repeats safely.
//
// One deadline spans the whole request, headers and body, because a body that
// stops arriving mid-stream is the same stall as one that never starts. The
// caller reads the body after the attempt loop has returned, so a stall that
// late aborts out of res.text()/res.arrayBuffer() as an error rather than a
// retry — bounded, which is the point, but not repeated. 30s is far above what
// any manifest or list index the refresh touches needs.
export const S3_REQUEST_TIMEOUT_MS = 30_000;
export const S3_REQUEST_ATTEMPTS = 3;
const S3_RETRY_BASE_MS = 250;
const S3_RETRY_CAP_MS = 2_000;
// A throttle is not a blip: when R2 says how long to wait, waiting less is
// three wasted attempts inside a second. Honour the hint, clamped the way the
// REST client below clamps it so a long or malformed one cannot stall a
// command for hours.
const S3_RATE_LIMIT_CAP_MS = 30_000;

export interface S3RequestDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Clock for reading a `Retry-After` date; injected for tests. */
  now?: () => number;
  /** Per-attempt deadline. Omitted (the default) means no deadline. */
  timeoutMs?: number;
  /** Attempts per request, including the first. Default 1, i.e. no retry. */
  maxAttempts?: number;
  /** Deadline signal factory; injected so tests need no real timers. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

/**
 * The policy the corpus refresh commands run their S3 storage on: a 30-second
 * deadline per attempt and three attempts for anything safe to repeat. Pass it
 * to `makeR2Client` or `r2InventoryClientFromVars`; everything that does not is
 * left on the single-attempt, no-deadline behaviour it has always had.
 */
export function refreshS3RequestDeps(overrides: S3RequestDeps = {}): S3RequestDeps {
  return {
    timeoutMs: S3_REQUEST_TIMEOUT_MS,
    maxAttempts: S3_REQUEST_ATTEMPTS,
    ...overrides,
  };
}

// 501 and 505 are the two 5xx a server returns because it will never serve the
// request; repeating them only delays the error. Every other 5xx is treated as
// transient, including ones R2 has not been seen to return.
function isTransientStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status !== 501 && status !== 505;
}

export function makeR2Client(
  cfg: R2Config,
  fetchFn: typeof fetch = fetch,
  deps: S3RequestDeps = {},
): R2InventoryClient {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 1);
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const now = deps.now ?? (() => Date.now());

  // aws.sign() returns a signed Request, which we then hand to the injected
  // fetch — keeps signing intact while making the network call stubbable.
  const send = async (
    url: string,
    init: RequestInit,
    retryable = true,
  ): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const last = !retryable || attempt >= maxAttempts - 1;
      let wait = Math.min(S3_RETRY_CAP_MS, S3_RETRY_BASE_MS * 2 ** attempt);
      // Signed outside the try: a signing failure is a bad credential or a bad
      // key, and repeating it only delays the message by three attempts.
      const signed = await aws.sign(
        url,
        timeoutMs === undefined ? init : { ...init, signal: timeoutSignal(timeoutMs) },
      );
      try {
        const res = await fetchFn(signed);
        if (last || !isTransientStatus(res.status)) return res;
        if (res.status === 429) {
          const hinted = parseRateLimitDelayMs(res.headers, now) ?? 0;
          wait = Math.min(S3_RATE_LIMIT_CAP_MS, Math.max(hinted, wait));
        }
        await res.text().catch(() => "");
      } catch (error) {
        if (last) throw error;
      }
      await sleep(wait);
    }
  };
  const signedFetch = (key: string, init: RequestInit, retryable = true): Promise<Response> =>
    send(`${base}/${encodePath(key)}`, init, retryable);
  const signedBucketFetch = (params: URLSearchParams, init: RequestInit): Promise<Response> =>
    send(`${base}?${params.toString()}`, init);

  return {
    async put(key, body, opts) {
      const headers: Record<string, string> = {};
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await signedFetch(key, { method: "PUT", body, headers });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 PUT ${key} failed: ${res.status} ${text}`);
      }
    },
    async putIfAbsent(key, body, opts) {
      const headers: Record<string, string> = { "if-none-match": "*" };
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await signedFetch(key, { method: "PUT", body, headers }, false);
      if (res.ok) return true;
      if (res.status === 412 || res.status === 409) return false;
      const text = await res.text().catch(() => "");
      throw new Error(`R2 PUT ${key} failed: ${res.status} ${text}`);
    },
    async putIfMatch(key, body, etag, opts) {
      const headers: Record<string, string> = { "if-match": quoteEtag(etag) };
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await signedFetch(key, { method: "PUT", body, headers }, false);
      if (res.ok) return true;
      if (res.status === 412 || res.status === 409) return false;
      const text = await res.text().catch(() => "");
      throw new Error(`R2 PUT ${key} failed: ${res.status} ${text}`);
    },
    async get(key) {
      const res = await signedFetch(key, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 GET ${key} failed: ${res.status} ${text}`);
      }
      return res.text();
    },
    async head(key) {
      const res = await signedFetch(key, { method: "HEAD" });
      if (res.status === 404) return false;
      if (res.ok) return true;
      const text = await res.text().catch(() => "");
      throw new Error(`R2 HEAD ${key} failed: ${res.status} ${text}`);
    },
    async delete(key) {
      const res = await signedFetch(key, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 DELETE ${key} failed: ${res.status} ${text}`);
      }
    },
    async listKeys() {
      return (await listObjects()).map((o) => o.key);
    },
    listObjects,
    async getWithEtag(key) {
      const res = await signedFetch(key, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 GET ${key} failed: ${res.status} ${text}`);
      }
      return { body: await res.text(), etag: normalizeEtag(res.headers.get("etag") ?? undefined) };
    },
    async getBytes(key) {
      const res = await signedFetch(key, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 GET ${key} failed: ${res.status} ${text}`);
      }
      return {
        body: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get("content-type"),
      };
    },
  };

  async function listObjects(prefix?: string): Promise<R2ObjectMeta[]> {
    const objects: R2ObjectMeta[] = [];
    const seen = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const params = new URLSearchParams({
        "list-type": "2",
        "max-keys": "1000",
      });
      if (prefix) params.set("prefix", prefix);
      if (continuationToken) params.set("continuation-token", continuationToken);
      const res = await signedBucketFetch(params, { method: "GET" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 LIST failed: ${res.status} ${text}`);
      }
      try {
        const page = parseS3ListPage(await res.text());
        objects.push(...page.objects);
        continuationToken = nextListToken(page.truncated, page.token, seen);
      } catch (cause) {
        throw new Error("R2 LIST failed: invalid S3 page or continuation token", { cause });
      }
    } while (continuationToken);
    return objects;
  }
}

// Cloudflare REST R2 (reading-lite-s1k.6.2): the same inventory surface as
// makeR2Client, authenticated with a Cloudflare API token instead of S3
// access keys. Cloud-agent environments carry CLOUDFLARE_API_TOKEN and can
// list/get/put objects this way even when CORPUS_R2_ACCESS_KEY is unset.
// Slashes in keys stay literal (R2 REST requirement); other reserved
// characters go through encodePath.
export interface RateLimitRetryDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// The Cloudflare REST API (R2 objects, Vectorize) throttles bursts with 429s
// (code 971 / 10000): the historical founder migration read ~3 objects per row and probed
// 2 vector ids per ready row, so a 500-row corpus is thousands of back-to-back
// calls. Unlike the worker's fetchWithRetry (which surfaces 429 to the queue),
// an operator CLI can simply wait: honor Retry-After when present, otherwise
// back off 1s·2^n; either way the wait is capped, for a bounded number of tries. Anything else is
// returned as-is for the caller's own status handling.
const RATE_LIMIT_ATTEMPTS = 6;
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_CAP_MS = 30_000;

export function withRateLimitRetry(
  fetchFn: typeof fetch,
  deps: RateLimitRetryDeps = {},
): (url: string, init: RequestInit) => Promise<Response> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(url, init);
      if (res.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS - 1) return res;
      const hinted = parseRateLimitDelayMs(res.headers, now) ?? 0;
      const backoff = RATE_LIMIT_BASE_MS * 2 ** attempt;
      await res.text().catch(() => "");
      // Clamp the final delay, not just the exponential term: a long or
      // malformed server hint must not stall an operator command for hours.
      await sleep(Math.min(RATE_LIMIT_CAP_MS, Math.max(hinted, backoff)));
    }
  };
}

export function makeR2RestClient(
  cfg: R2RestConfig,
  fetchFn: typeof fetch = fetch,
  deps: RateLimitRetryDeps = {},
): R2InventoryClient {
  const objectsBase = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}/objects`;
  const authHeader = `Bearer ${cfg.apiToken}`;
  const send = withRateLimitRetry(fetchFn, deps);

  const objectUrl = (key: string) => `${objectsBase}/${encodePath(key)}`;

  const authedFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", authHeader);
    return send(url, { ...init, headers });
  };

  const throwIfUnsuccessfulJson = async (res: Response, action: string, key?: string): Promise<void> => {
    const text = await res.text().catch(() => "");
    let parsed: { success?: boolean; errors?: { message?: string }[] } | null = null;
    try {
      parsed = JSON.parse(text) as { success?: boolean; errors?: { message?: string }[] };
    } catch {
      parsed = null;
    }
    if (parsed?.success === true) return;
    const detail = parsed?.errors?.map((e) => e.message).filter(Boolean).join("; ") || text;
    const where = key === undefined ? action : `${action} ${key}`;
    throw new Error(`R2 ${where} failed: ${res.status} ${detail}`);
  };

  return {
    async put(key, body, opts) {
      const headers: Record<string, string> = {};
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await authedFetch(objectUrl(key), { method: "PUT", body, headers });
      if (!res.ok) {
        await throwIfUnsuccessfulJson(res, "PUT", key);
        return;
      }
      // 2xx still carries a JSON envelope whose success flag is the contract.
      const text = await res.text().catch(() => "");
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as { success?: boolean };
        if (parsed.success === false) {
          throw new Error(`R2 PUT ${key} failed: ${res.status} ${text}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("R2 PUT")) throw err;
      }
    },
    async putIfAbsent(key, body, opts) {
      const headers: Record<string, string> = { "if-none-match": "*" };
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await authedFetch(objectUrl(key), { method: "PUT", body, headers });
      if (res.ok) return true;
      if (res.status === 412 || res.status === 409) return false;
      await throwIfUnsuccessfulJson(res, "PUT", key);
      return false;
    },
    async putIfMatch(key, body, etag, opts) {
      const headers: Record<string, string> = { "if-match": quoteEtag(etag) };
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await authedFetch(objectUrl(key), { method: "PUT", body, headers });
      if (res.status === 412 || res.status === 409) return false;
      if (!res.ok) throw new Error(`R2 PUT ${key} failed: HTTP ${res.status}`);
      const text = await res.text();
      // Cloudflare's object-upload endpoint may return an empty 2xx body. When
      // it does return JSON, the success flag is authoritative.
      if (text.trim() === "") return true;
      let envelope: { success?: unknown };
      try {
        envelope = JSON.parse(text) as { success?: unknown };
      } catch {
        throw new Error(`R2 PUT ${key} failed: malformed Cloudflare response`);
      }
      if (envelope.success === true) return true;
      if (envelope.success === false) {
        throw new Error(`R2 PUT ${key} failed: Cloudflare response success=false`);
      }
      throw new Error(`R2 PUT ${key} failed: malformed Cloudflare response`);
    },
    async get(key) {
      const res = await authedFetch(objectUrl(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        await throwIfUnsuccessfulJson(res, "GET", key);
        return null;
      }
      return res.text();
    },
    async head(key) {
      const res = await authedFetch(objectUrl(key), { method: "HEAD" });
      if (res.status === 404) return false;
      if (!res.ok) {
        await throwIfUnsuccessfulJson(res, "HEAD", key);
        return false;
      }
      return true;
    },
    async delete(key) {
      const res = await authedFetch(objectUrl(key), { method: "DELETE" });
      if (res.status === 404) return;
      if (!res.ok) await throwIfUnsuccessfulJson(res, "DELETE", key);
    },
    async listKeys() {
      return (await listObjects()).map((o) => o.key);
    },
    listObjects,
    async getWithEtag(key) {
      const res = await authedFetch(objectUrl(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        // null here means "no such manifest" to the planner, so a failed read
        // must throw even when the envelope claims success.
        await throwIfUnsuccessfulJson(res, "GET", key);
        throw new Error(`R2 GET ${key} failed: ${res.status}`);
      }
      return { body: await res.text(), etag: normalizeEtag(res.headers.get("etag") ?? undefined) };
    },
    async getBytes(key) {
      const res = await authedFetch(objectUrl(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        await throwIfUnsuccessfulJson(res, "GET", key);
        return null;
      }
      return {
        body: new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get("content-type"),
      };
    },
  };

  async function listObjects(prefix?: string): Promise<R2ObjectMeta[]> {
    const objects: R2ObjectMeta[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ per_page: "1000" });
      if (prefix) params.set("prefix", prefix);
      if (cursor) params.set("cursor", cursor);
      const res = await authedFetch(`${objectsBase}?${params.toString()}`, { method: "GET" });
      if (!res.ok) {
        await throwIfUnsuccessfulJson(res, "LIST");
        throw new Error(`R2 LIST failed: ${res.status}`);
      }
      const json: unknown = await res.json().catch((cause) => {
        throw new Error("R2 LIST failed: invalid JSON", { cause });
      });
      // Preserve provider diagnostics for explicitly unsuccessful responses.
      if (json && typeof json === "object" && "success" in json && json.success === false) {
        await throwIfUnsuccessfulJson(Response.json(json), "LIST");
      }
      try {
        const page = parseRestListPage(json);
        objects.push(...page.objects);
        cursor = nextListToken(page.truncated, page.token, seen);
      } catch (cause) {
        throw new Error("R2 LIST failed: invalid REST page or continuation cursor", { cause });
      }
    } while (cursor);
    return objects;
  }
}

// R2 quotes ETags, and the REST API prefixes them with the weak validator
// marker. Strip both so every surface reports the same token.
function normalizeEtag(etag: string | undefined): string {
  if (!etag) return "";
  return etag.replace(/^W\//, "").replaceAll('"', "");
}

function quoteEtag(etag: string): string {
  return `"${etag.replace(/^W\//, "").replaceAll('"', "")}"`;
}

// Prefer S3 credentials when both are present (existing operator .corpus.vars);
// otherwise use the Cloudflare REST API with CLOUDFLARE_API_TOKEN, which is
// what cloud-agent environments actually have.
export function r2InventoryClientFromVars(
  vars: Record<string, string | undefined>,
  bucket: string,
  fetchFn: typeof fetch = fetch,
  deps: S3RequestDeps = {},
): R2InventoryClient {
  const accountId = firstDefined(vars, ["CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]);
  const accessKeyId = vars.CORPUS_R2_ACCESS_KEY;
  const secretAccessKey = vars.CORPUS_R2_SECRET_KEY;
  const apiToken = firstDefined(vars, ["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]);
  if (!accountId) {
    throw new Error("missing credential: CORPUS_R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID (env or .corpus.vars)");
  }
  if (accessKeyId && secretAccessKey) {
    return makeR2Client({ accountId, accessKeyId, secretAccessKey, bucket }, fetchFn, deps);
  }
  if (apiToken) {
    // The REST client has its own 429 backoff and no deadline, so it takes only
    // the two fields it can honour. A caller that asked for the refresh policy
    // does not get a deadline on this credential path — the operations note
    // records that, and the Timing: block is what makes a stall there visible.
    const { sleep, now } = deps;
    return makeR2RestClient({ accountId, apiToken, bucket }, fetchFn, { sleep, now });
  }
  throw new Error(
    "missing credential: CORPUS_R2_ACCESS_KEY and CORPUS_R2_SECRET_KEY, or CLOUDFLARE_API_TOKEN / CORPUS_CF_API_TOKEN (env or .corpus.vars)",
  );
}

function firstDefined(vars: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = vars[name];
    if (value) return value;
  }
  return undefined;
}

export function makeVectorizeClient(
  cfg: VectorizeConfig,
  fetchFn: typeof fetch = fetch,
  deps: RateLimitRetryDeps = {},
): VectorizeAdminClient {
  const indexBase = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/vectorize/v2/indexes/${cfg.index}`;
  const authHeader = `Bearer ${cfg.apiToken}`;
  const send = withRateLimitRetry(fetchFn, deps);
  return {
    async upsert(vectors) {
      if (vectors.length === 0) return;
      const ndjson = vectors
        .map((v) => JSON.stringify(cfg.namespace === undefined ? v : { ...v, namespace: cfg.namespace }))
        .join("\n");
      const res = await send(`${indexBase}/upsert`, {
        method: "POST",
        headers: {
          authorization: authHeader,
          "content-type": "application/x-ndjson",
        },
        body: ndjson,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Vectorize upsert failed: ${res.status} ${text}`);
      }
    },
    async query(vector, opts) {
      return runQuery({ vector }, opts);
    },
    async queryById(id, opts) {
      return runQuery({ vectorId: id }, opts);
    },
    async getByIds(ids) {
      if (ids.length === 0) return [];
      const res = await send(`${indexBase}/get_by_ids`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Vectorize get_by_ids failed: ${res.status} ${text}`);
      }
      // The v2 result is the vector array; tolerate a {vectors: []} wrapper.
      type WireVector = Omit<StoredVector, "namespace"> & { namespace?: string | null };
      const json = (await res.json()) as {
        result?: WireVector[] | { vectors?: WireVector[] };
      };
      const raw = json.result;
      const vectors = Array.isArray(raw) ? raw : raw?.vectors ?? [];
      // The API serializes an unnamespaced vector's namespace as null (or
      // omits it); normalize here so consumers can rely on `undefined`
      // meaning "legacy, no namespace" without null-vs-absent case analysis.
      return vectors.map(({ namespace, ...rest }) => ({
        ...rest,
        ...(namespace == null ? {} : { namespace }),
      }));
    },
  };

  // `vector` and `vectorId` are the two spellings of the same POST; everything
  // else about the request — topK, metadata mode, namespace filter — is shared,
  // so neither caller can drift from the other.
  async function runQuery(
    subject: { vector: number[] } | { vectorId: string },
    opts: { topK: number; returnMetadata?: boolean },
  ): Promise<VectorizeMatch[]> {
    const res = await send(`${indexBase}/query`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({
        ...subject,
        topK: opts.topK,
        returnMetadata: opts.returnMetadata ? "all" : "none",
        ...(cfg.namespace === undefined ? {} : { namespace: cfg.namespace }),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Vectorize query failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { result?: { matches?: VectorizeMatch[] } };
    return json.result?.matches ?? [];
  }
}

// A view of an R2Client confined to one tenant's key root (reading-lite-
// s1k.4.3). The batch pipeline and its phase modules speak RELATIVE keys
// (index/list.json, readings/…); wrapping the client is what maps them into a
// tenant's namespace, so no phase module needs to know about tenancy. The
// empty root is the pre-tenant global layout and returns the client unchanged.
export function withKeyRoot(client: R2Client, keyRoot: string): R2Client {
  if (keyRoot === "") return client;
  return {
    put: (key, body, opts) => client.put(`${keyRoot}${key}`, body, opts),
    putIfAbsent: (key, body, opts) => client.putIfAbsent(`${keyRoot}${key}`, body, opts),
    ...(client.putIfMatch === undefined
      ? {}
      : { putIfMatch: (key: string, body: Uint8Array | string, etag: string, opts?: R2PutOptions) =>
          client.putIfMatch!(`${keyRoot}${key}`, body, etag, opts) }),
    get: (key) => client.get(`${keyRoot}${key}`),
    head: (key) => client.head(`${keyRoot}${key}`),
    delete: (key) => client.delete(`${keyRoot}${key}`),
    listKeys: async () =>
      (await client.listKeys())
        .filter((key) => key.startsWith(keyRoot))
        .map((key) => key.slice(keyRoot.length)),
  };
}

export function dryRunR2(log: (line: string) => void = (l) => process.stderr.write(l + "\n")): R2Client {
  return {
    async put(key) {
      log(`[dry-run] R2 PUT ${key}`);
    },
    async putIfAbsent(key) {
      log(`[dry-run] R2 PUT if absent ${key}`);
      return true;
    },
    async putIfMatch(key) {
      log(`[dry-run] R2 PUT if match ${key}`);
      return true;
    },
    async get() {
      return null;
    },
    async head() {
      return false;
    },
    async delete(key) {
      log(`[dry-run] R2 DELETE ${key}`);
    },
    async listKeys() {
      log("[dry-run] R2 LIST");
      return [];
    },
  };
}

export function dryRunVectorize(
  log: (line: string) => void = (l) => process.stderr.write(l + "\n"),
): VectorizeClient {
  return {
    async upsert(vectors) {
      for (const v of vectors) log(`[dry-run] Vectorize upsert ${v.id}`);
    },
    async query() {
      return [];
    },
  };
}

export function encodePath(key: string): string {
  return key
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}
