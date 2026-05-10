import { promises as fs } from "node:fs";
import path from "node:path";

export interface MarkdownArticle {
  filePath: string;
  fileName: string;
  markdown: string;
  bytes: number;
  title?: string;
  sourceUrl?: string;
}

export interface DuplicateGroup {
  sourceUrl: string;
  files: MarkdownArticle[];
  selected: MarkdownArticle;
}

export interface MarkdownImportPlan {
  files: MarkdownArticle[];
  missingSource: MarkdownArticle[];
  selected: MarkdownArticle[];
  duplicateGroups: DuplicateGroup[];
}

export const MARKDOWN_IMPORT_MAX_BYTES = 128_000;

export interface OversizedMarkdownArticle {
  article: MarkdownArticle;
  limitBytes: number;
  excessBytes: number;
}

export async function readMarkdownDir(dir: string): Promise<MarkdownArticle[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const out: MarkdownArticle[] = [];
  for (const fileName of files) {
    const filePath = path.resolve(dir, fileName);
    const markdown = await fs.readFile(filePath, "utf8");
    out.push(parseMarkdownArticle(filePath, markdown));
  }
  return out;
}

export function parseMarkdownArticle(
  filePath: string,
  markdown: string,
): MarkdownArticle {
  const title = firstMarkdownTitle(markdown);
  const sourceUrl = sourceUrlFromMarkdown(markdown);
  return {
    filePath,
    fileName: path.basename(filePath),
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    ...(title === undefined ? {} : { title }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  };
}

export function findOversizedMarkdownArticles(
  articles: MarkdownArticle[],
  limitBytes = MARKDOWN_IMPORT_MAX_BYTES,
): OversizedMarkdownArticle[] {
  return articles
    .filter((article) => article.bytes > limitBytes)
    .map((article) => ({
      article,
      limitBytes,
      excessBytes: article.bytes - limitBytes,
    }));
}

export function buildImportPlan(files: MarkdownArticle[]): MarkdownImportPlan {
  const missingSource = files.filter((file) => file.sourceUrl === undefined);
  const bySource = new Map<string, MarkdownArticle[]>();
  for (const file of files) {
    if (!file.sourceUrl) continue;
    const group = bySource.get(file.sourceUrl) ?? [];
    group.push(file);
    bySource.set(file.sourceUrl, group);
  }

  const selected: MarkdownArticle[] = [];
  const duplicateGroups: DuplicateGroup[] = [];
  for (const [sourceUrl, group] of [...bySource.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const preferred = selectPreferredArticle(group);
    selected.push(preferred);
    if (group.length > 1) {
      duplicateGroups.push({
        sourceUrl,
        files: [...group].sort((a, b) => a.fileName.localeCompare(b.fileName)),
        selected: preferred,
      });
    }
  }

  return {
    files,
    missingSource,
    selected,
    duplicateGroups,
  };
}

export function selectPreferredArticle(files: MarkdownArticle[]): MarkdownArticle {
  if (files.length === 0) {
    throw new Error("selectPreferredArticle requires at least one file");
  }
  return [...files].sort((a, b) => {
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    return a.fileName.localeCompare(b.fileName);
  })[0]!;
}

function firstMarkdownTitle(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  const title = match?.[1]?.trim();
  return title && title.length > 0 ? title : undefined;
}

function sourceUrlFromMarkdown(markdown: string): string | undefined {
  const line = markdown.match(/^\*\*Source:\*\*\s*(.+)$/im)?.[1]?.trim();
  if (!line) return undefined;
  const match = line.match(/https?:\/\/[^\s<>)\]]+/i);
  if (!match) return undefined;
  const url = match[0].replace(/[.,;:]+$/g, "");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}
