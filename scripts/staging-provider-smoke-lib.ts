export interface StagingSmokeTarget {
  execute: boolean;
  base: string;
}

type JsonObject = Record<string, unknown>;
const PROJECT_STAGING_ORIGIN =
  "https://reading-lite-staging.bellbm.workers.dev";

export function validateStagingSmokeTarget(
  target: StagingSmokeTarget,
): void {
  if (!target.execute) {
    throw new Error("staging provider smoke requires --execute");
  }
  const url = new URL(target.base);
  if (url.protocol !== "https:") {
    throw new Error("staging provider smoke requires HTTPS");
  }
  if (url.origin !== PROJECT_STAGING_ORIGIN) {
    throw new Error(
      `refusing target outside the project staging origin: ${url.origin}`,
    );
  }
}

export function summarizeDiagnostics(
  diagnostics: JsonObject,
): JsonObject {
  const pointers = diagnostics.pointers as JsonObject | undefined;
  const byId = pointers?.by_id as JsonObject | undefined;
  const byUrl = pointers?.by_url as JsonObject | undefined;
  if (
    byId?.exists !== true ||
    byId.matches_manifest !== true ||
    byUrl?.exists !== true ||
    byUrl.matches_manifest !== true
  ) {
    throw new Error("pointer diagnostics did not match the manifest");
  }
  if (
    typeof diagnostics.index_item !== "object" ||
    diagnostics.index_item === null
  ) {
    throw new Error("diagnostics did not include an index_item");
  }
  const manifest = diagnostics.manifest as JsonObject | undefined;
  const indexItem = diagnostics.index_item as JsonObject;
  if (
    typeof manifest?.status !== "string" ||
    indexItem.status !== manifest.status
  ) {
    throw new Error(
      `index_item status ${String(indexItem.status)} did not match manifest status ${String(manifest?.status)}`,
    );
  }
  return {
    pointers,
    index_item: indexItem,
    attempt_count: Array.isArray(diagnostics.attempts)
      ? diagnostics.attempts.length
      : undefined,
  };
}

export function isAttemptTerminal(
  manifest: JsonObject,
  attemptId: string,
): boolean {
  const activeAttempt = manifest.active_attempt as JsonObject | undefined;
  const lastAttempt = manifest.last_attempt as JsonObject | undefined;
  return (
    activeAttempt?.id !== attemptId &&
    lastAttempt?.id === attemptId &&
    lastAttempt.status === "succeeded"
  );
}
