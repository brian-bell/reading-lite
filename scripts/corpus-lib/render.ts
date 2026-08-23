import type { AuditRow } from "./types";
import type { StatusTally } from "./audit";

const esc = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|");

export function renderIndexMarkdown(
  failed: AuditRow[],
  pending: AuditRow[],
  teasers: AuditRow[],
  tally: StatusTally,
  generatedDate: string,
  failedOrphanDups: AuditRow[] = [],
): string {
  const stranded = pending.filter((p) => p.class === "stranded");
  const orphan = pending.filter((p) => p.class === "orphan-dup");
  const fresh = pending.filter((p) => p.class === "fresh");
  let md = `# Corpus non-ready inventory\n\n`;
  md += `Every reading in the reading-lite corpus that is **not** \`ready\` (\`failed\` + \`pending\`), plus \`ready\` readings that are only a paywall teaser.\n\n`;
  md += `Corpus totals: **${tally.ready} ready · ${tally.failed} failed · ${tally.pending} pending**.\n\n`;
  md += `- **Failed:** ${failed.length} unique URLs\n`;
  md += `- **Failed — orphan dup** (url already ready; droppable cruft): ${failedOrphanDups.length}\n`;
  md += `- **Pending — stranded** (never completed): ${stranded.length}\n`;
  md += `- **Pending — orphan dup** (url already ready; cosmetic): ${orphan.length}\n`;
  md += `- **Pending — in-flight** (within TTL; no action): ${fresh.length}\n`;
  md += `- **Ready-but-teaser:** ${teasers.length}\n\n`;

  md += `## Failed (${failed.length})\n\n| URL | Reason | Code @ stage | × | Reading ID |\n|---|---|---|---|---|\n`;
  for (const r of failed) md += `| ${esc(r.short)} | ${esc(r.reason)} | ${r.code} @ ${r.stage} | ${r.attempts} | ${r.reading_id} |\n`;

  md += `\n## Failed — orphan duplicates (${failedOrphanDups.length})\n\nFailed copies of a url that **already has a \`ready\` reading** — cosmetic cruft, not real failures. The ready copy owns the by-url pointer + embedding, so drop these with \`npm run ops -- corpus drop <url> --execute\` (it keeps the ready copy). \`× N\` is the failed-copy count per url.\n\n| URL | Reason | × | Reading ID |\n|---|---|---|---|\n`;
  for (const r of failedOrphanDups) md += `| ${esc(r.short)} | ${esc(r.reason)} | ${r.attempts} | ${r.reading_id} |\n`;

  md += `\n## Pending — stranded (${stranded.length})\n\nReprocess candidates — stuck before completion, never reached a terminal state.\n\n| URL | Stuck at | Age (d) | Trigger | × | Reading ID |\n|---|---|---|---|---|---|\n`;
  for (const r of stranded) md += `| ${esc(r.short)} | ${r.stuck_stage} | ${r.age_days} | ${r.trigger} | ${r.attempts} | ${r.reading_id} |\n`;

  md += `\n## Pending — orphan duplicates (${orphan.length})\n\nThe url already has a \`ready\` reading; these are cosmetic index cruft.\n\n| URL | Age (d) | Reading ID |\n|---|---|---|\n`;
  for (const r of orphan) md += `| ${esc(r.short)} | ${r.age_days} | ${r.reading_id} |\n`;

  md += `\n## Ready-but-teaser (${teasers.length})\n\n| URL | Title | Reading ID |\n|---|---|---|\n`;
  for (const r of teasers) md += `| ${esc(r.short)} | ${esc(r.title).slice(0, 40)} | ${r.reading_id} |\n`;

  md += `\n_Generated ${generatedDate}. Failed/pending titles are often blank (never summarized) so URL is the identifier. Teaser scan covers pragmaticengineer + *.substack.com. Full URLs + raw errors in index.json._\n`;
  return md;
}
