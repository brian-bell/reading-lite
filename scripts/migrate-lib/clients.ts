export interface R2PutOptions {
  contentType?: string;
}

export interface R2Client {
  put(key: string, body: Uint8Array | string, opts?: R2PutOptions): Promise<void>;
  head(key: string): Promise<boolean>;
}

export interface VectorizeUpsertVector {
  id: string;
  values: number[];
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface VectorizeClient {
  upsert(vectors: VectorizeUpsertVector[]): Promise<void>;
}
