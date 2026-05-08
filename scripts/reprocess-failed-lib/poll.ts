import type { ManifestErrorLike } from "./records";

export interface PollDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface PollOptions {
  base: string;
  headers: Record<string, string>;
  id: string;
  intervalMs: number;
  timeoutMs: number;
}

export type PollOutcome =
  | { kind: "ready" }
  | { kind: "failed"; error?: ManifestErrorLike }
  | { kind: "timeout"; lastStatus: string };

interface PolledManifest {
  status: string;
  error?: ManifestErrorLike;
}

export async function pollReadingTerminal(
  opts: PollOptions,
  deps: PollDeps,
): Promise<PollOutcome> {
  const start = deps.now();
  let lastStatus = "pending";
  while (true) {
    const url = new URL(`/readings/${encodeURIComponent(opts.id)}`, opts.base);
    const res = await deps.fetch(url, { headers: opts.headers });
    if (!res.ok) {
      throw new Error(
        `GET /readings/${opts.id} -> ${res.status} ${await res.text()}`.trim(),
      );
    }
    const manifest = (await res.json()) as PolledManifest;
    lastStatus = manifest.status;
    if (manifest.status === "ready") return { kind: "ready" };
    if (manifest.status === "failed") {
      return { kind: "failed", error: manifest.error };
    }
    if (deps.now() - start >= opts.timeoutMs) {
      return { kind: "timeout", lastStatus };
    }
    await deps.sleep(opts.intervalMs);
  }
}
