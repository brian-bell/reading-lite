import type { ExtractedContent } from "../../../src/modules/extractor";
import type { BatchTarget, DroppedTarget, ExtractedTarget } from "./types";

export interface ExtractDeps {
  // The reading's saved markdown (R2 `extracted.md`), or null if absent.
  loadExtracted(keyPrefix: string): Promise<string | null>;
  // Fresh extraction (fetch → readability → markdown), browser UA.
  extract(url: string): Promise<ExtractedContent>;
}

export interface ExtractResult {
  extracted: ExtractedTarget[];
  dropped: DroppedTarget[];
}

// The Anthropic batch can't fetch URLs, so article text must be in hand first.
// Prefer the already-captured `extracted.md`; otherwise re-extract locally
// (browser UA). Targets with no usable markdown are dropped, not summarized.
export async function extractTargets(
  targets: BatchTarget[],
  deps: ExtractDeps,
): Promise<ExtractResult> {
  const extracted: ExtractedTarget[] = [];
  const dropped: DroppedTarget[] = [];

  for (const target of targets) {
    try {
      // Only reuse R2 extracted.md when the manifest's content descriptors are
      // trustworthy — i.e. the reading is currently ready+captured. A failed
      // manifest has zeroed content_bytes/sha (markFailed), so reusing it would
      // stamp a ready manifest with bogus descriptors; fresh-extract instead
      // (which also matches the realtime reprocess path: url readings re-fetch).
      const m = target.manifest;
      const canReuse = m.status === "ready" && m.content_status === "captured";
      const saved = canReuse ? await deps.loadExtracted(target.keyPrefix) : null;
      if (saved && saved.trim().length > 0) {
        extracted.push({
          target,
          markdown: saved,
          ...(target.manifest.title === undefined ? {} : { title: target.manifest.title }),
        });
        continue;
      }

      const fresh = await deps.extract(target.url);
      if (fresh.content_status !== "captured" || !fresh.markdown?.trim()) {
        dropped.push({
          readingId: target.readingId,
          reason: `extract yielded no markdown (${fresh.content_status}, ${fresh.content_type})`,
        });
        continue;
      }
      extracted.push({
        target,
        markdown: fresh.markdown,
        ...(fresh.title === undefined ? {} : { title: fresh.title }),
        fresh,
      });
    } catch (e) {
      dropped.push({
        readingId: target.readingId,
        reason: `extract threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return { extracted, dropped };
}
