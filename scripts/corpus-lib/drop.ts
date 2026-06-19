// Pure resolver for `corpus-drop`: turns a mixed list of selectors (reading ids
// like `rd_ABC`, or URLs) into the concrete reading targets to delete, using
// `index/list.json` as the source of truth for each id's key_prefix.
//
// Drop is non-ready only — a `ready` reading owns its `index/by-url/{hash}`
// pointer and a Vectorize embedding, so deleting it this way would dangle both.
// Hence:
//   - an explicitly-named ready id is a hard error (you asked for it by id),
//   - a url selector silently keeps any ready copy and drops only the non-ready
//     copies (the orphan-dup cleanup case), erroring only if the url has *no*
//     non-ready copy to drop.

export interface DropListItem {
  id: string;
  url: string;
  key_prefix: string;
  status?: string;
}

export interface DropTarget {
  id: string;
  prefix: string;
  url: string;
}

export type ResolveResult =
  | { ok: true; targets: DropTarget[]; keptReady: DropListItem[] }
  | { ok: false; errors: string[] };

const isId = (s: string): boolean => s.startsWith("rd_");

export function resolveDropTargets(items: DropListItem[], selectors: string[]): ResolveResult {
  const byId = new Map<string, DropListItem>(items.map((i) => [i.id, i]));
  const errors: string[] = [];
  const targetsById = new Map<string, DropTarget>();
  const keptById = new Map<string, DropListItem>();

  const take = (it: DropListItem): void => {
    targetsById.set(it.id, { id: it.id, prefix: it.key_prefix, url: it.url });
  };

  for (const sel of selectors) {
    if (isId(sel)) {
      const it = byId.get(sel);
      if (!it) {
        errors.push(`id not found in index/list.json: ${sel}`);
        continue;
      }
      if (it.status === "ready") {
        errors.push(`refusing ${sel}: it is ready — deleting it would dangle its by-url pointer + embedding`);
        continue;
      }
      take(it);
      continue;
    }

    // URL selector: match every copy of this url.
    const matches = items.filter((i) => i.url === sel);
    if (matches.length === 0) {
      errors.push(`url not found in index/list.json: ${sel}`);
      continue;
    }
    const droppable = matches.filter((i) => i.status !== "ready");
    if (droppable.length === 0) {
      errors.push(`refusing ${sel}: url only has ready copies — would dangle by-url pointer + embedding`);
      continue;
    }
    for (const it of droppable) take(it);
    for (const it of matches) if (it.status === "ready") keptById.set(it.id, it);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, targets: [...targetsById.values()], keptReady: [...keptById.values()] };
}
