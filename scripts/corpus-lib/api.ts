import type { ApiTarget } from "./config";

export interface ApiDeps extends ApiTarget {
  fetch: typeof fetch;
}

export type SubmitOutcome = "new" | "existing" | "error";

export interface ApiResult {
  outcome: SubmitOutcome;
  id?: string;
  error?: string;
}

// POST /readings/:id/reprocess { force: true } — re-runs the pipeline for an
// existing reading. 202 = a fresh attempt was queued.
export async function reprocessReading(id: string, deps: ApiDeps): Promise<ApiResult> {
  return post(`${deps.base}/readings/${id}/reprocess`, { force: true }, deps);
}

// POST /readings/import-markdown — create/update a reading straight from
// markdown (no fetch). 202 new, 200 already-existing.
export async function importMarkdown(
  body: { source_url: string; markdown: string; title?: string },
  deps: ApiDeps,
): Promise<ApiResult> {
  return post(`${deps.base}/readings/import-markdown`, body, deps);
}

export interface LookupResult {
  found: boolean;
  id?: string;
  error?: string;
}

// GET /readings/lookup?url= — read-only resolve of a URL to its owning reading.
// 404 = no owner; 200/202 = an owner exists (ready/pending). Used to detect a
// pre-existing reading under a noncanonical URL variant before importing.
export async function lookupReading(url: string, deps: ApiDeps): Promise<LookupResult> {
  try {
    const res = await deps.fetch(`${deps.base}/readings/lookup?url=${encodeURIComponent(url)}`, {
      headers: { authorization: `Bearer ${deps.token}` },
    });
    if (res.status === 404) return { found: false };
    if (res.ok || res.status === 202) {
      const json = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { found: true, id: typeof json.id === "string" ? json.id : undefined };
    }
    const snippet = (await res.text().catch(() => "")).slice(0, 160);
    return { found: false, error: `${res.status} ${snippet}`.trim() };
  } catch (e) {
    return { found: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function post(url: string, body: unknown, deps: ApiDeps): Promise<ApiResult> {
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 202 || res.status === 200) {
      const json = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { outcome: res.status === 202 ? "new" : "existing", id: typeof json.id === "string" ? json.id : undefined };
    }
    const snippet = (await res.text().catch(() => "")).slice(0, 160);
    return { outcome: "error", error: `${res.status} ${snippet}`.trim() };
  } catch (e) {
    return { outcome: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
