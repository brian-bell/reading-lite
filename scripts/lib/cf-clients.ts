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
  get(key: string): Promise<string | null>;
  head(key: string): Promise<boolean>;
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
  };
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
    async get() {
      return null;
    },
    async head() {
      return false;
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
