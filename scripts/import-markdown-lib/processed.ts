import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { MarkdownArticle } from "./parse";

export interface ProcessedMove {
  fileName: string;
  sourcePath: string;
  destinationPath: string;
}

export function processedDirFor(dir: string): string {
  return path.join(path.resolve(dir), "processed");
}

export async function moveArticlesToProcessed(
  articles: MarkdownArticle[],
  dir: string,
): Promise<ProcessedMove[]> {
  if (articles.length === 0) return [];

  const processedDir = processedDirFor(dir);
  await fs.mkdir(processedDir, { recursive: true });

  const moves: ProcessedMove[] = [];
  for (const article of articles) {
    const destinationPath = await nextAvailablePath(processedDir, article.fileName);
    await fs.copyFile(
      article.filePath,
      destinationPath,
      fsConstants.COPYFILE_EXCL,
    );
    await fs.unlink(article.filePath);
    moves.push({
      fileName: article.fileName,
      sourcePath: article.filePath,
      destinationPath,
    });
  }

  return moves;
}

async function nextAvailablePath(dir: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  let suffix = 0;

  while (true) {
    const candidate =
      suffix === 0
        ? path.join(dir, fileName)
        : path.join(dir, `${parsed.name}-${suffix + 1}${parsed.ext}`);
    try {
      await fs.access(candidate);
      suffix += 1;
    } catch (err) {
      if (isNotFound(err)) return candidate;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
