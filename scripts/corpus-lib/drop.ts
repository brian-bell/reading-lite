// Pure resolver for `corpus-drop`: turns a mixed list of selectors (reading ids
// like `rd_ABC`, or URLs) into the concrete reading targets to delete, using
// the tenant's readings as the source of truth for each id's key_prefix.
//
// Drop is non-ready only by default. Nothing dangles any more — URL ownership,
// the embedding and the relationships are rows that cascade with the reading —
// but a ready reading is a live library entry with a published summary, and
// deleting one is not corpus repair. So:
//   - an explicitly-named ready id is a hard error (you asked for it by id),
//   - a url selector silently keeps any ready copy and drops only the non-ready
//     copies (the orphan-dup cleanup case), erroring only if the url has *no*
//     non-ready copy to drop.
//
// Staging cleanup can opt into ready deletion with `allowReady`. It no longer
// has to clean vectors by hand: reading_embeddings cascades.

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

// Only delete the reading's row once every one of its content objects is
// gone. The row is what makes the reading findable, so deleting it first would
// strand the bytes with nothing left to name them: a re-run could not retry,
// and only an account wipe would ever collect them. Leaving the row in place
// keeps the drop visible and re-runnable, which is the same reason this used
// to hold back the index/list.json rewrite.
export function shouldDeleteRow(erroredDeletes: number): boolean {
  return erroredDeletes === 0;
}

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
        errors.push(`id not found in this tenant's corpus: ${sel}`);
        continue;
      }
      if (it.status === "ready" && !allowReady) {
        errors.push(`refusing ${sel}: it is ready — dropping a live library entry is not corpus repair`);
        continue;
      }
      take(it);
      continue;
    }

    // URL selector: match every copy of this url.
    const matches = items.filter((i) => i.url === sel);
    if (matches.length === 0) {
      errors.push(`url not found in this tenant's corpus: ${sel}`);
      continue;
    }
    const droppable = allowReady ? matches : matches.filter((i) => i.status !== "ready");
    if (droppable.length === 0) {
      errors.push(`refusing ${sel}: url only has ready copies — dropping a live library entry is not corpus repair`);
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
