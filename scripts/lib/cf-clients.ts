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
}

export interface R2ObjectBody {
  body: Uint8Array;
  contentType: string | null;
}

// The inventory-grade superset the founder migration needs (reading-lite-
// s1k.6.1): size/etag listings for exact copy plans and byte-faithful reads
// for binary-safe copies. A separate interface so the many in-memory R2Client
// fakes in tests keep compiling; makeR2Client always returns the superset.
export interface R2InventoryClient extends R2Client {
  putIfMatch(key: string, body: Uint8Array | string, etag: string, opts?: R2PutOptions): Promise<boolean>;
  listObjects(prefix?: string): Promise<R2ObjectMeta[]>;
  getBytes(key: string): Promise<R2ObjectBody | null>;
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

// Superset for the founder migration (reading-lite-s1k.6.1): fetch stored
// vectors by id so legacy vectors can be re-upserted into the tenant
// namespace without a paid re-embed. get_by_ids addresses vectors by their
// index-unique id regardless of namespace, which is exactly what lets one
// call probe legacy (bare-id) and migrated (tenant-prefixed) vectors at once.
export interface VectorizeAdminClient extends VectorizeClient {
  getByIds(ids: string[]): Promise<StoredVector[]>;
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
// Every attempt gets a fresh deadline, and the request is re-signed each time
// because a SigV4 signature carries the timestamp it was made at.
//
// Retries cover writes as well as reads. A conditional PUT whose response was
// lost may already have landed, so the retry can come back 412 and be reported
// as a lost CAS — but that is also what an un-retried timeout reports, and
// only the retry can turn a genuinely failed attempt into a success, so it is
// never the worse of the two. No manifest is written twice either way: the
// ETag the second attempt carries matches only the version the first replaced.
export const S3_REQUEST_TIMEOUT_MS = 30_000;
const S3_REQUEST_ATTEMPTS = 3;
const S3_RETRY_BASE_MS = 250;
const S3_RETRY_CAP_MS = 2_000;

export interface S3RequestDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt deadline. Default 30s. */
  timeoutMs?: number;
  /** Attempts per request, including the first. Default 3. */
  maxAttempts?: number;
  /** Deadline signal factory; injected so tests need no real timers. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
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
  const timeoutMs = deps.timeoutMs ?? S3_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? S3_REQUEST_ATTEMPTS);
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  // aws.sign() returns a signed Request, which we then hand to the injected
  // fetch — keeps signing intact while making the network call stubbable.
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= maxAttempts - 1;
      try {
        const signed = await aws.sign(url, { ...init, signal: timeoutSignal(timeoutMs) });
        const res = await fetchFn(signed);
        if (last || !isTransientStatus(res.status)) return res;
        await res.text().catch(() => "");
      } catch (error) {
        if (last) throw error;
      }
      await sleep(Math.min(S3_RETRY_CAP_MS, S3_RETRY_BASE_MS * 2 ** attempt));
    }
  };
  const signedFetch = (key: string, init: RequestInit): Promise<Response> =>
    send(`${base}/${encodePath(key)}`, init);
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
      const res = await signedFetch(key, { method: "PUT", body, headers });
      if (res.ok) return true;
      if (res.status === 412 || res.status === 409) return false;
      const text = await res.text().catch(() => "");
      throw new Error(`R2 PUT ${key} failed: ${res.status} ${text}`);
    },
    async putIfMatch(key, body, etag, opts) {
      const headers: Record<string, string> = { "if-match": quoteEtag(etag) };
      if (opts?.contentType) headers["content-type"] = opts.contentType;
      const res = await signedFetch(key, { method: "PUT", body, headers });
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
      const xml = await res.text();
      for (const block of extractXmlTags(xml, "Contents")) {
        const key = extractXmlTags(block, "Key")[0];
        if (key === undefined) continue;
        objects.push({
          key: decodeXmlEntities(key),
          size: Number(extractXmlTags(block, "Size")[0] ?? "0"),
          etag: decodeXmlEntities(extractXmlTags(block, "ETag")[0] ?? "").replace(/"/g, ""),
        });
      }
      const isTruncated = extractXmlTags(xml, "IsTruncated")[0] === "true";
      continuationToken = isTruncated
        ? decodeXmlEntities(extractXmlTags(xml, "NextContinuationToken")[0] ?? "")
        : undefined;
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
// (code 971 / 10000): the founder migration reads ~3 objects per row and probes
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
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ per_page: "1000" });
      if (prefix) params.set("prefix", prefix);
      if (cursor) params.set("cursor", cursor);
      const res = await authedFetch(`${objectsBase}?${params.toString()}`, { method: "GET" });
      if (!res.ok) {
        await throwIfUnsuccessfulJson(res, "LIST");
        return objects;
      }
      const json = (await res.json()) as {
        success?: boolean;
        errors?: { message?: string }[];
        result?: Array<{ key?: string; size?: number | string; etag?: string }>;
        result_info?: { cursor?: string; is_truncated?: boolean };
      };
      if (json.success === false) {
        const detail = json.errors?.map((e) => e.message).filter(Boolean).join("; ") || "unsuccessful";
        throw new Error(`R2 LIST failed: ${res.status} ${detail}`);
      }
      for (const item of json.result ?? []) {
        if (!item.key) continue;
        objects.push({
          key: item.key,
          size: Number(item.size ?? 0),
          etag: normalizeRestEtag(item.etag),
        });
      }
      const info = json.result_info;
      cursor = info?.is_truncated ? info.cursor : undefined;
    } while (cursor);
    return objects;
  }
}

function normalizeRestEtag(etag: string | undefined): string {
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
): R2InventoryClient {
  const accountId = firstDefined(vars, ["CORPUS_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]);
  const accessKeyId = vars.CORPUS_R2_ACCESS_KEY;
  const secretAccessKey = vars.CORPUS_R2_SECRET_KEY;
  const apiToken = firstDefined(vars, ["CORPUS_CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"]);
  if (!accountId) {
    throw new Error("missing credential: CORPUS_R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID (env or .corpus.vars)");
  }
  if (accessKeyId && secretAccessKey) {
    return makeR2Client({ accountId, accessKeyId, secretAccessKey, bucket }, fetchFn);
  }
  if (apiToken) {
    return makeR2RestClient({ accountId, apiToken, bucket }, fetchFn);
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

function extractXmlTags(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? "");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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
      const res = await send(`${indexBase}/query`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({
          vector,
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
