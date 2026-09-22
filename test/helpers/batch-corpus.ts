// Orchestration stub. Persistence/ownership behavior is tested against Postgres.
import { vi } from "vitest";
import type { Manifest } from "../../src/schemas/manifest";
import type { BatchCorpus } from "../../scripts/corpus-lib/batch/postgres";
export function stubBatchCorpus(drafts: Map<string, string>): BatchCorpus {
  return {
    getByUrl: vi.fn(async () => null),
    readManifest: vi.fn(async (prefix) => {
      const raw = drafts.get(`${prefix}/manifest.json`);
      return raw ? (JSON.parse(raw) as Manifest) : null;
    }),
    findReadingByUrl: vi.fn(async () => null),
    contentKeys: vi.fn(async (prefix) => ({
      rawKey: `${prefix}/raw.html`,
      extractedKey: `${prefix}/extracted.md`,
    })),
    query: vi.fn(async () => []),
    discardContent: vi.fn(async () => {}),
    activate: vi.fn(async (m, prefix) => {
      drafts.set(`${prefix}/manifest.json`, JSON.stringify(m));
      return true;
    }),
    disposition: vi.fn(async () => "active" as const),
    publish: vi.fn(async (t, m) => {
      drafts.set(`${t.keyPrefix}/manifest.json`, JSON.stringify(m));
      return true;
    }),
    fail: vi.fn(async (t, m) => {
      drafts.set(`${t.keyPrefix}/manifest.json`, JSON.stringify(m));
      return true;
    }),
  };
}
