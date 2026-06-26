import { ManifestSchema, type Manifest } from "../../../src/schemas/manifest";
import { manifestToIndexItem } from "../../../src/modules/stores/reading-store";
import type { R2Client } from "../../lib/cf-clients";
import { mergeListIndex } from "./list-index-write";
import { serializeReadingPointer, type ReadingPointer } from "./pointers";
import type { ActivatingSidecar, ExtractedTarget, PersistedSidecar } from "./types";
import type { WriteReportRow } from "./write-phase";

export interface ActivationDeps {
  r2: Pick<R2Client, "get" | "put" | "putIfAbsent">;
  model: string;
  now(): string;
  saveSidecar(sidecar: PersistedSidecar): Promise<void>;
  log?: (line: string) => void;
}

export interface ActivationResult {
  activated: ExtractedTarget[];
  skipped: WriteReportRow[];
}

export async function activateFreshTargets(
  targets: ExtractedTarget[],
  deps: ActivationDeps,
): Promise<ActivationResult> {
  const freshTargets = targets.filter((t) => t.freshActivation);
  if (freshTargets.length === 0) return { activated: targets, skipped: [] };

  await deps.saveSidecar(activatingSidecar(freshTargets, deps.model));

  const activated: ExtractedTarget[] = [];
  const skipped: WriteReportRow[] = [];
  const touched = [];

  for (const target of targets) {
    const policy = target.freshActivation;
    if (!policy) {
      activated.push(target);
      continue;
    }

    if (policy.kind === "occupied-needs-repair") {
      skipped.push({ id: target.target.readingId, status: "skipped", reason: policy.reason });
      continue;
    }

    const pointer = serializeReadingPointer(target.target.readingId, target.target.keyPrefix);
    const pointerKey = `index/by-url/${target.target.urlHash}`;

    if (policy.kind === "create-new") {
      const claimed = await deps.r2.putIfAbsent(pointerKey, pointer, { contentType: "application/json" });
      if (!claimed) {
        skipped.push({
          id: target.target.readingId,
          status: "skipped",
          reason: "by-url slot already owned at batch submit",
        });
        continue;
      }
    } else if (policy.kind === "create-existing-failed") {
      const before = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (!isExpectedFailed(before, policy.expected)) {
        skipped.push({
          id: policy.expected.id,
          status: "skipped",
          reason: "planned failed reading changed before by-url claim",
        });
        continue;
      }
      const claimed = await deps.r2.putIfAbsent(pointerKey, pointer, { contentType: "application/json" });
      if (!claimed) {
        skipped.push({
          id: policy.expected.id,
          status: "skipped",
          reason: "by-url slot already owned at batch submit",
        });
        continue;
      }
      const after = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (!isExpectedFailed(after, policy.expected)) {
        throw new Error(`batch activation claimed ${policy.expected.id}, but its manifest changed before pending write`);
      }
    } else {
      const currentPointer = await readPointer(deps.r2, pointerKey);
      const currentManifest = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (!pointerEquals(currentPointer, policy.expected.id, policy.expected.keyPrefix)) {
        skipped.push({ id: policy.expected.id, status: "skipped", reason: "by-url pointer changed before activation" });
        continue;
      }
      if (!isExpectedFailed(currentManifest, policy.expected)) {
        skipped.push({ id: policy.expected.id, status: "skipped", reason: "planned failed reading changed before activation" });
        continue;
      }
      const finalPointer = await readPointer(deps.r2, pointerKey);
      const finalManifest = await readManifest(deps.r2, policy.expected.keyPrefix);
      if (
        !pointerEquals(finalPointer, policy.expected.id, policy.expected.keyPrefix) ||
        !isExpectedFailed(finalManifest, policy.expected)
      ) {
        throw new Error(`batch activation lost the ${policy.expected.id} ownership revalidation race`);
      }
    }

    await writeFreshContent(target, deps.r2);
    const manifest = buildPendingManifest(target, deps.now());
    await deps.r2.put(`${target.target.keyPrefix}/manifest.json`, JSON.stringify(manifest), {
      contentType: "application/json",
    });
    await deps.r2.put(`index/by-id/${target.target.readingId}`, pointer, { contentType: "application/json" });
    touched.push(manifestToIndexItem(manifest, target.target.keyPrefix));
    activated.push({ ...target, contentAlreadyWritten: true });
  }

  if (touched.length > 0) await mergeListIndex({ r2: deps.r2, log: deps.log }, touched);

  return { activated, skipped };
}

function activatingSidecar(targets: ExtractedTarget[], model: string): ActivatingSidecar {
  return {
    batchId: "",
    model,
    processingStatus: "activating",
    resultsUrl: null,
    targets: targets.map(({ target }) => ({
      id: target.readingId,
      customId: target.readingId,
      keyPrefix: target.keyPrefix,
      url: target.url,
      urlHash: target.urlHash,
      createdAt: target.createdAt,
    })),
  };
}

function buildPendingManifest(target: ExtractedTarget, now: string): Manifest {
  const markdownBytes = new TextEncoder().encode(target.markdown).byteLength;
  return ManifestSchema.parse({
    ...target.target.manifest,
    id: target.target.readingId,
    url: target.target.url,
    url_hash: target.target.urlHash,
    source_type: "markdown",
    status: "pending",
    active_attempt: {
      id: `batch_${target.target.readingId}`,
      trigger: "import",
      status: "running",
      stage: "summarize",
      started_at: now,
    },
    error: undefined,
    extracted_bytes: markdownBytes,
    updated_at: now,
  });
}

async function writeFreshContent(
  target: ExtractedTarget,
  r2: Pick<R2Client, "put">,
): Promise<void> {
  const fresh = target.fresh;
  if (!fresh) return;
  await r2.put(`${target.target.keyPrefix}/raw.${extToken(fresh.content_type)}`, fresh.raw, {
    contentType: fresh.content_type,
  });
  if (fresh.markdown) {
    await r2.put(`${target.target.keyPrefix}/extracted.md`, fresh.markdown, {
      contentType: "text/markdown; charset=utf-8",
    });
  }
}

async function readManifest(
  r2: Pick<R2Client, "get">,
  keyPrefix: string,
): Promise<Manifest | null> {
  const raw = await r2.get(`${keyPrefix}/manifest.json`);
  return raw ? ManifestSchema.parse(JSON.parse(raw)) : null;
}

async function readPointer(r2: Pick<R2Client, "get">, key: string): Promise<ReadingPointer | null> {
  const raw = await r2.get(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ReadingPointer>;
  if (typeof parsed.id !== "string" || typeof parsed.key_prefix !== "string") return null;
  return { id: parsed.id, key_prefix: parsed.key_prefix };
}

function isExpectedFailed(
  manifest: Manifest | null,
  expected: { id: string; keyPrefix: string; url: string; urlHash: string; createdAt: string },
): boolean {
  return (
    manifest?.status === "failed" &&
    manifest.id === expected.id &&
    manifest.url === expected.url &&
    manifest.url_hash === expected.urlHash &&
    manifest.created_at === expected.createdAt
  );
}

function pointerEquals(pointer: ReadingPointer | null, id: string, keyPrefix: string): boolean {
  return pointer?.id === id && pointer.key_prefix === keyPrefix;
}

function extToken(contentType: string): string {
  const major = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (major === "text/html" || major === "application/xhtml+xml") return "html";
  if (major === "text/markdown") return "md";
  if (major === "application/pdf") return "pdf";
  if (major === "application/json") return "json";
  if (major.startsWith("text/")) return "txt";
  return "bin";
}
