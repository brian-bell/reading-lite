import type { ListIndexItem } from "../../../src/schemas/api";
import type { R2Client } from "../../lib/cf-clients";

const LIST_INDEX_KEY = "index/list.json";

export interface ListIndexWriteDeps {
  r2: Pick<R2Client, "get" | "put">;
  log?: (line: string) => void;
}

export async function mergeListIndex(deps: ListIndexWriteDeps, touched: ListIndexItem[]): Promise<void> {
  const raw = await deps.r2.get(LIST_INDEX_KEY);
  let items: ListIndexItem[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { items?: ListIndexItem[] };
      if (Array.isArray(parsed.items)) items = parsed.items;
    } catch {
      deps.log?.(`  ! index/list.json was unparseable; rebuilding from touched items only`);
    }
  }

  const touchedIds = new Set(touched.map((t) => t.id));
  const touchedKeyPrefixes = new Set(touched.map((t) => t.key_prefix));
  const merged = [
    ...items.filter((i) => !touchedIds.has(i.id) && !touchedKeyPrefixes.has(i.key_prefix)),
    ...touched,
  ];
  await deps.r2.put(LIST_INDEX_KEY, JSON.stringify({ version: 1, items: merged }), {
    contentType: "application/json",
  });
}
