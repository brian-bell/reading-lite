// The list row a manifest seeded at a key prefix should read back as. Tests
// build expected list rows and seed fixture list rows with it; production
// projects list rows straight from PostgreSQL (PgReadingStore).
import type { ListIndexItem } from "../../src/schemas/api";
import type { Manifest } from "../../src/schemas/manifest";

export function manifestToIndexItem(
  m: Manifest,
  keyPrefix: string,
): ListIndexItem {
  const item: ListIndexItem = {
    id: m.id,
    key_prefix: keyPrefix,
    url: m.url,
    status: m.status,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
  if (m.title !== undefined) item.title = m.title;
  if (m.tldr !== undefined) item.tldr = m.tldr;
  if (m.tags !== undefined) item.tags = m.tags;
  if (m.keywords !== undefined) item.keywords = m.keywords;
  if (m.novelty_verdict !== undefined) item.novelty_verdict = m.novelty_verdict;
  if (m.similarity !== undefined) item.similarity = m.similarity;
  if (m.source_date !== undefined) item.source_date = m.source_date;
  if (m.error !== undefined) item.error = m.error;
  if (m.active_attempt !== undefined) item.active_attempt = m.active_attempt;
  if (m.last_attempt !== undefined) item.last_attempt = m.last_attempt;
  if (m.enrichment_degradation !== undefined) item.enrichment_degradation = m.enrichment_degradation;
  return item;
}
