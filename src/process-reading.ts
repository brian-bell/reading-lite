import {
  buildKeyPrefix,
  manifestToIndexItem,
  ReadingStore,
} from "./modules/stores/reading-store";
import { SimilarityStore } from "./modules/stores/similarity-store";
import { extractFromUrl } from "./modules/extractor";
import { embed } from "./modules/embeddings";
import {
  summarizeReading,
  type SimilarContext,
} from "./modules/anthropic";
import type { Manifest, ManifestError } from "./schemas/manifest";
import type { Env } from "./index";
import type { Services } from "./services";
import { sha256Hex } from "./services";

export interface ProcessReadingArgs {
  id: string;
  url: string;
  urlHash: string;
  createdAt: string;
  keyPrefix: string;
}

export async function processReading(
  args: ProcessReadingArgs,
  env: Env,
  services: Services,
): Promise<void> {
  const reader = new ReadingStore(env.READINGS_BUCKET);
  const similarity = new SimilarityStore(env.READINGS_INDEX);

  try {
    const extracted = await extractFromUrl(args.url, {
      fetch: services.fetch,
      timeoutMs: parseIntEnv(env.FETCH_TIMEOUT_MS, 20_000),
      maxBytes: parseIntEnv(env.FETCH_MAX_BYTES, 10 * 1024 * 1024),
    });

    await reader.writeRaw(args.keyPrefix, extToken(extracted.content_type), extracted.raw, extracted.content_type);
    if (extracted.markdown) {
      await reader.writeExtracted(args.keyPrefix, extracted.markdown);
    }

    const promptText = extracted.markdown ?? `(non-text content; raw bytes saved at raw.${extToken(extracted.content_type)})`;

    // Embed the extracted text to get top-K similar.
    const queryEmbed = await embed(truncateForEmbed(promptText), {
      fetch: services.fetch,
      apiKey: env.OPENAI_API_KEY,
    });
    const similar = await similarity.query(queryEmbed.embedding, 5);
    const similarContext: SimilarContext[] = similar
      .filter((s) => s.id !== args.id)
      .map((s) => ({ id: s.id, url: s.url, title: s.title }));

    const llm = await summarizeReading(
      {
        url: args.url,
        extractedText: promptText,
        title: extracted.title,
        similarReadings: similarContext,
      },
      {
        fetch: services.fetch,
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
      },
    );

    // Embed the TL;DR for the persistent vector (more representative than the full text).
    const tldrEmbed = await embed(llm.reading.tldr, {
      fetch: services.fetch,
      apiKey: env.OPENAI_API_KEY,
    });

    await similarity.upsert(args.id, tldrEmbed.embedding, {
      url: args.url,
      title: llm.reading.title,
      tags: llm.reading.tags,
      created_at: args.createdAt,
    });

    const finalManifest: Manifest = {
      id: args.id,
      url: args.url,
      url_hash: args.urlHash,
      status: "ready",
      title: llm.reading.title,
      tldr: llm.reading.tldr,
      tags: llm.reading.tags,
      keywords: llm.reading.keywords,
      people: llm.reading.people,
      orgs: llm.reading.orgs,
      novelty_verdict: llm.reading.novelty_verdict,
      connections: llm.reading.connections,
      summary_markdown: llm.reading.summary_markdown,
      content_type: extracted.content_type,
      content_status: extracted.content_status,
      content_bytes: extracted.content_bytes,
      extracted_bytes: extracted.markdown
        ? new TextEncoder().encode(extracted.markdown).byteLength
        : undefined,
      content_sha256: extracted.content_sha256,
      fetched_at: services.now(),
      created_at: args.createdAt,
      updated_at: services.now(),
      usage: {
        anthropic_input_tokens: llm.usage.input_tokens,
        anthropic_output_tokens: llm.usage.output_tokens,
        openai_embedding_tokens:
          queryEmbed.usage.total_tokens + tldrEmbed.usage.total_tokens,
      },
    };

    await reader.writeManifest(args.keyPrefix, finalManifest);
    await reader.writeByUrlPointer(
      args.urlHash,
      { id: args.id, key_prefix: args.keyPrefix },
    );
    await reader.appendOrReplaceListIndexItem(
      manifestToIndexItem(finalManifest, args.keyPrefix),
    );
  } catch (e) {
    await markFailed(reader, args, services, e);
  }
}

async function markFailed(
  reader: ReadingStore,
  args: ProcessReadingArgs,
  services: Services,
  e: unknown,
): Promise<void> {
  console.error(e);
  const error: ManifestError = {
    code: e instanceof Error ? e.name : "unknown_error",
    message: e instanceof Error ? e.message : String(e),
  };
  const manifest: Manifest = {
    id: args.id,
    url: args.url,
    url_hash: args.urlHash,
    status: "failed",
    error,
    content_type: "application/octet-stream",
    content_status: "failed",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: args.createdAt,
    updated_at: services.now(),
  };
  await reader.writeManifest(args.keyPrefix, manifest);
  await reader.appendOrReplaceListIndexItem(
    manifestToIndexItem(manifest, args.keyPrefix),
  );
  // Intentionally do NOT write the by-url pointer: failed readings should not
  // dedup future submissions of the same URL.
}

export async function newReadingArgs(
  url: string,
  services: Services,
): Promise<ProcessReadingArgs> {
  const id = services.newId();
  const createdAt = services.now();
  const keyPrefix = buildKeyPrefix(id, createdAt);
  const urlHash = await sha256Hex(url);
  return { id, url, urlHash, createdAt, keyPrefix };
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

function extToken(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}

export const EMBED_MAX_CHARS = 8000;
export function truncateForEmbed(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text;
  // Trim a trailing high surrogate so we don't leave a malformed UTF-16 pair
  // when the cut lands between two halves of a surrogate-encoded codepoint.
  return text.slice(0, EMBED_MAX_CHARS).replace(/[\uD800-\uDBFF]$/, "");
}
