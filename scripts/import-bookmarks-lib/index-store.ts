import { promises as fs } from "node:fs";
import path from "node:path";

export interface IndexEntry {
  id: string;
  submitted_at: string;
  classification: "new" | "existing";
}

// Map of base URL → URL → entry. Per-base scoping keeps dev and prod indices
// from colliding in a single file.
export type Index = Record<string, Record<string, IndexEntry>>;

export async function loadIndex(filePath: string): Promise<Index> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object at top level");
    }
    return parsed as Index;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`index file ${filePath} is malformed: ${msg}`);
  }
}

export async function saveIndex(filePath: string, index: Index): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify(index, null, 2) + "\n";
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, filePath);
}

export function filterUnseen(
  urls: string[],
  index: Index,
  baseUrl: string,
): { unseen: string[]; seen: string[] } {
  const known = index[baseUrl] ?? {};
  const unseen: string[] = [];
  const seen: string[] = [];
  for (const url of urls) {
    if (known[url]) seen.push(url);
    else unseen.push(url);
  }
  return { unseen, seen };
}

export function recordResult(
  index: Index,
  baseUrl: string,
  url: string,
  entry: IndexEntry,
): void {
  const bucket = index[baseUrl] ?? (index[baseUrl] = {});
  bucket[url] = entry;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
