import { AwsClient } from "aws4fetch";

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
  get(key: string): Promise<string | null>;
  head(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
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

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface VectorizeConfig {
  accountId: string;
  index: string;
  apiToken: string;
}

export function makeR2Client(cfg: R2Config, fetchFn: typeof fetch = fetch): R2Client {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;

  // aws.sign() returns a signed Request, which we then hand to the injected
  // fetch — keeps signing intact while making the network call stubbable.
  const signedFetch = async (key: string, init: RequestInit): Promise<Response> => {
    const signed = await aws.sign(`${base}/${encodePath(key)}`, init);
    return fetchFn(signed);
  };
  const signedBucketFetch = async (params: URLSearchParams, init: RequestInit): Promise<Response> => {
    const signed = await aws.sign(`${base}?${params.toString()}`, init);
    return fetchFn(signed);
  };

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
      return res.ok;
    },
    async delete(key) {
      const res = await signedFetch(key, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "");
        throw new Error(`R2 DELETE ${key} failed: ${res.status} ${text}`);
      }
    },
    async listKeys() {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const params = new URLSearchParams({
          "list-type": "2",
          "max-keys": "1000",
        });
        if (continuationToken) params.set("continuation-token", continuationToken);
        const res = await signedBucketFetch(params, { method: "GET" });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`R2 LIST failed: ${res.status} ${text}`);
        }
        const xml = await res.text();
        keys.push(...extractXmlTags(xml, "Key").map(decodeXmlEntities));
        const isTruncated = extractXmlTags(xml, "IsTruncated")[0] === "true";
        continuationToken = isTruncated
          ? decodeXmlEntities(extractXmlTags(xml, "NextContinuationToken")[0] ?? "")
          : undefined;
      } while (continuationToken);
      return keys;
    },
  };
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
): VectorizeClient {
  const indexBase = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/vectorize/v2/indexes/${cfg.index}`;
  const authHeader = `Bearer ${cfg.apiToken}`;
  return {
    async upsert(vectors) {
      if (vectors.length === 0) return;
      const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
      const res = await fetchFn(`${indexBase}/upsert`, {
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
      const res = await fetchFn(`${indexBase}/query`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({
          vector,
          topK: opts.topK,
          returnMetadata: opts.returnMetadata ? "all" : "none",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Vectorize query failed: ${res.status} ${text}`);
      }
      const json = (await res.json()) as { result?: { matches?: VectorizeMatch[] } };
      return json.result?.matches ?? [];
    },
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
