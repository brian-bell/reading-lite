import { createHash } from "node:crypto";

export function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function byUrlPointerKey(url: string): string {
  return `index/by-url/${urlHash(url)}`;
}

export function ownedByUrlPointerKey(params: {
  url: string;
  pointerRaw: string | null;
  id: string;
  keyPrefix: string;
}): string | null {
  if (params.pointerRaw === null) return null;
  let pointer: unknown;
  try {
    pointer = JSON.parse(params.pointerRaw);
  } catch {
    return null;
  }
  if (!pointer || typeof pointer !== "object") return null;
  const p = pointer as { id?: unknown; key_prefix?: unknown };
  if (p.id !== params.id || p.key_prefix !== params.keyPrefix) return null;
  return byUrlPointerKey(params.url);
}

export function deletionTargetFromCurrentItem(
  id: string,
  item: unknown,
): { id: string; prefix: string; url: string } {
  if (!item || typeof item !== "object") {
    throw new Error(`id ${id} not found in index/list.json`);
  }
  const current = item as {
    status?: unknown;
    key_prefix?: unknown;
    url?: unknown;
  };
  if (current.status === "ready") {
    throw new Error(`${id} is ready`);
  }
  if (typeof current.key_prefix !== "string" || typeof current.url !== "string") {
    throw new Error(`id ${id} has an invalid index/list.json entry`);
  }
  return { id, prefix: current.key_prefix, url: current.url };
}

export function hasReadySibling(
  items: Array<{ id?: unknown; url?: unknown; status?: unknown }>,
  target: { id: string; url: string },
): boolean {
  return items.some(
    (item) =>
      item.id !== target.id &&
      item.url === target.url &&
      item.status === "ready",
  );
}
