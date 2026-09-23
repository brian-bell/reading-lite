// Pure resolver for `corpus-drop`: turns a mixed list of selectors (reading ids
// like `rd_ABC`, or URLs) into the concrete reading targets to delete, using
// the tenant's reading rows as the source of truth for each id's key_prefix.
//
// Drop is non-ready only by default — a `ready` reading is the live owner of
// its URL and carries the embedding its neighbours were measured against, so
// removing it is a corpus change rather than cleanup (the command needs
// --allow-ready for that, and refuses it on production). Dropping a failed or
// pending orphan-duplicate never disturbs the survivor: its URL claim, content
// and embedding cascade with its own row. Hence:
//   - an explicitly-named ready id is a hard error (you asked for it by id),
//   - a url selector silently keeps any ready copy and drops only the non-ready
//     copies (the orphan-dup cleanup case), erroring only if the url has *no*
//     non-ready copy to drop.
//
// Staging cleanup can opt into ready deletion with `allowReady`. Under ADR
// 0005 the URL claim and the embedding are rows that cascade with the reading,
// so there is nothing else for the caller to clean up.

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
  status?: string;
}

export type ResolveResult =
  | { ok: true; targets: DropTarget[]; keptReady: DropListItem[] }
  | { ok: false; errors: string[] };


const isId = (s: string): boolean => s.startsWith("rd_");

export function resolveDropTargets(
  items: DropListItem[],
  selectors: string[],
  opts: { allowReady?: boolean } = {},
): ResolveResult {
  const allowReady = opts.allowReady === true;
  const byId = new Map<string, DropListItem>(items.map((i) => [i.id, i]));
  const errors: string[] = [];
  const targetsById = new Map<string, DropTarget>();
  const keptById = new Map<string, DropListItem>();

  const take = (it: DropListItem): void => {
    targetsById.set(it.id, { id: it.id, prefix: it.key_prefix, url: it.url, status: it.status });
  };

  for (const sel of selectors) {
    if (isId(sel)) {
      const it = byId.get(sel);
      if (!it) {
        errors.push(`id not found in this tenant's corpus: ${sel} (check --tenant and --bucket)`);
        continue;
      }
      if (it.status === "ready" && !allowReady) {
        errors.push(`refusing ${sel}: it is ready — deleting it would drop its URL claim + embedding`);
        continue;
      }
      take(it);
      continue;
    }

    // URL selector: match every copy of this url.
    const matches = items.filter((i) => i.url === sel);
    if (matches.length === 0) {
      errors.push(`url not found in this tenant's corpus: ${sel} (check --tenant and --bucket)`);
      continue;
    }
    const droppable = allowReady ? matches : matches.filter((i) => i.status !== "ready");
    if (droppable.length === 0) {
      errors.push(`refusing ${sel}: url only has ready copies — would drop URL claim + embedding`);
      continue;
    }
    for (const it of droppable) take(it);
    if (!allowReady) {
      for (const it of matches) if (it.status === "ready") keptById.set(it.id, it);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, targets: [...targetsById.values()], keptReady: [...keptById.values()] };
}
