// GET /api/readings pager. Note the caveat this spec deliberately avoids
// promising: offset pagination runs over a mutable list, so rows can be
// skipped or duplicated across a mutation window. Skips are harmless (the next
// timer run catches them), but duplicates are not: the orchestrator plans every
// returned row and does not recheck eligibility while acting, so a row that
// shifts across a page boundary would be extracted and submitted twice — and if
// the first attempt has already landed failed, the second submit enqueues a
// second round of paid work rather than no-oping. So dedupe by id here.
// Callers still must not assume an exact snapshot.

import { ListReadingsResponseSchema, type ListIndexItem } from "../../src/schemas/api";

const PAGE_LIMIT = 100;

// A failure that invalidates the whole run (we can't trust a partial listing).
export class AgentFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFatalError";
  }
}

export interface PollDeps {
  fetch: typeof fetch;
  base: string;
  token: string;
}

export async function pageAllReadings(deps: PollDeps): Promise<ListIndexItem[]> {
  const rows: ListIndexItem[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const res = await deps.fetch(`${deps.base}/api/readings?offset=${offset}&limit=${PAGE_LIMIT}`, {
      headers: { authorization: `Bearer ${deps.token}` },
    });
    if (res.status !== 200) {
      const snippet = (await res.text().catch(() => "")).slice(0, 160);
      throw new AgentFatalError(`GET /api/readings failed: ${res.status} ${snippet}`.trim());
    }
    const body = await res.json().catch(() => undefined);
    const parsed = ListReadingsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentFatalError(`GET /api/readings returned an unexpected body: ${parsed.error.message.slice(0, 200)}`);
    }
    for (const row of parsed.data.readings) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (!parsed.data.has_more) return rows;
    // Advance by rows received, not rows kept — the offset indexes the server's
    // list, which still contains the duplicates we dropped.
    offset += parsed.data.readings.length;
  }
}
