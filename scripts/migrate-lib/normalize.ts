import { createHash } from "node:crypto";

const VERDICT_REMAP: Record<string, "novel" | "familiar" | "duplicate"> = {
  novel: "novel",
  familiar: "familiar",
  duplicate: "duplicate",
  extends_existing: "familiar",
};

export function normalizeBacklitRow(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (r.content_status !== "captured") return null;

  const url = typeof r.url === "string" ? r.url : "";
  const out: Record<string, unknown> = {
    id: r.id,
    url,
    url_hash: sha256Hex(url),
    title: r.title,
    tldr: r.tldr,
    tags: r.tags,
    keywords: r.keywords,
    people: r.people,
    orgs: r.orgs,
    novelty_verdict: remapVerdict(r.novelty_verdict),
    connections: remapConnections(r.connections),
    summary_markdown: nonEmptyString(r.summary),
    embedding: r.embedding,
    content_type: r.content_type,
    content_status: r.content_status,
    content_bytes: r.content_bytes,
    extracted_bytes: r.extracted_bytes,
    content_sha256: r.content_sha256,
    fetched_at: nonEmptyString(r.fetched_at),
    created_at: r.created_at,
    updated_at:
      typeof r.updated_at === "string" && r.updated_at.length > 0
        ? r.updated_at
        : r.created_at,
  };
  return out;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function remapVerdict(v: unknown): "novel" | "familiar" | "duplicate" | undefined {
  if (typeof v !== "string") return undefined;
  return VERDICT_REMAP[v];
}

function remapConnections(v: unknown): Array<{ id: string; reason: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<{ id: string; reason: string }> = [];
  for (const c of v) {
    if (!c || typeof c !== "object") continue;
    const conn = c as Record<string, unknown>;
    const id = conn.reading_id ?? conn.id;
    const reason = conn.reason;
    if (typeof id === "string" && id.length > 0 && typeof reason === "string" && reason.length > 0) {
      out.push({ id, reason });
    }
  }
  return out.length > 0 ? out : undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
