import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import type { ByUrlPointer } from "./prepare-fresh-markdown";

// The two R2 reads the bulk paths share: the by-url ownership pointer and the
// manifest behind a key prefix. Single-homed so the recover path, the
// fresh-markdown run, and the CLI dry-run can't drift in how they parse them.
export interface R2Getter {
  get(key: string): Promise<string | null>;
}

export async function getByUrl(r2: R2Getter, urlHash: string): Promise<ByUrlPointer | null> {
  const raw = await r2.get(`index/by-url/${urlHash}`);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ByUrlPointer>;
  if (typeof parsed.id !== "string" || typeof parsed.key_prefix !== "string") return null;
  return { id: parsed.id, key_prefix: parsed.key_prefix };
}

export async function readManifest(r2: R2Getter, keyPrefix: string): Promise<Manifest | null> {
  const raw = await r2.get(`${keyPrefix}/manifest.json`);
  return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
}

// The ownership-read pair prepareFreshMarkdown wants, bound to one R2 client.
export function r2ReadDeps(r2: R2Getter): {
  getByUrl(urlHash: string): Promise<ByUrlPointer | null>;
  readManifest(keyPrefix: string): Promise<Manifest | null>;
} {
  return {
    getByUrl: (urlHash) => getByUrl(r2, urlHash),
    readManifest: (keyPrefix) => readManifest(r2, keyPrefix),
  };
}
