// Rebuild index/list.json from manifests via the Worker's manifestToIndexItem
// projection. Used to backfill newly denormalized list fields (keywords) without
// reprocessing readings. The write is a plain put, so --execute requires
// --sole-writer the same way corpus-ingest does.

import { manifestToIndexItem } from "../../src/modules/stores/list-index";
import type { ListIndexItem } from "../../src/schemas/api";
import type { Manifest } from "../../src/schemas/manifest";

export interface RebuildScanRow {
  keyPrefix: string;
  manifest: Manifest;
}

export interface ListRebuildPlan {
  items: ListIndexItem[];
  currentCount: number;
  rebuiltCount: number;
  keywordGainCount: number;
  complete: boolean;
}

export function planListRebuild(input: {
  currentItems: Array<{ id: string; keywords?: string[] }>;
  rows: RebuildScanRow[];
  complete: boolean;
}): ListRebuildPlan {
  const currentById = new Map(input.currentItems.map((item) => [item.id, item]));
  const items = input.rows.map((row) => manifestToIndexItem(row.manifest, row.keyPrefix));
  let keywordGainCount = 0;
  for (const item of items) {
    const prior = currentById.get(item.id);
    const gained = (item.keywords?.length ?? 0) > 0 && (prior?.keywords?.length ?? 0) === 0;
    if (gained) keywordGainCount += 1;
  }
  return {
    items,
    currentCount: input.currentItems.length,
    rebuiltCount: items.length,
    keywordGainCount,
    complete: input.complete,
  };
}

export function rebuildWriteGuard(opts: {
  execute: boolean;
  soleWriter: boolean;
  complete: boolean;
}): { action: "dry-run" | "write" | "refuse"; reason: string } {
  if (!opts.complete) {
    return {
      action: "refuse",
      reason: "REFUSED: list rebuild scan was truncated; not writing a partial index",
    };
  }
  if (!opts.execute) {
    return { action: "dry-run", reason: "" };
  }
  if (!opts.soleWriter) {
    return {
      action: "refuse",
      reason: "REFUSED: corpus-rebuild-list --execute requires --sole-writer",
    };
  }
  return { action: "write", reason: "" };
}
