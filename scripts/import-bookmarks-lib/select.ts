import type { Folder, Link } from "./parse";

// Resolves a slash-delimited folder path against the bookmark tree.
// Matching is case-insensitive and trims whitespace around each segment;
// the first matching folder at each level wins.
export function selectFolder(root: Folder, path: string): Folder | null {
  const segments = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  let current: Folder = root;
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    const next = current.folders.find((f) => f.name.toLowerCase() === lower);
    if (!next) return null;
    current = next;
  }
  return current;
}

// Flattens all links under the folder (including descendants) in source order,
// deduping by URL — the first occurrence wins.
export function collectLinks(folder: Folder): Link[] {
  const seen = new Set<string>();
  const out: Link[] = [];
  visit(folder, seen, out);
  return out;
}

function visit(folder: Folder, seen: Set<string>, out: Link[]): void {
  for (const link of folder.links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
  }
  for (const sub of folder.folders) {
    visit(sub, seen, out);
  }
}
