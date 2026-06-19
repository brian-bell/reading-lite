import type { AnthropicBatchClient, BatchInfo } from "./clients";

export interface PollDeps {
  batch: AnthropicBatchClient;
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxPolls?: number;
  log?: (line: string) => void;
}

const DEFAULT_INTERVAL_MS = 30_000;
// 24h ceiling (the Anthropic batch max) at the default interval.
const DEFAULT_MAX_POLLS = Math.ceil((24 * 60 * 60 * 1000) / DEFAULT_INTERVAL_MS);

// Poll a Message Batch to completion. Returns the ended BatchInfo (results_url
// set). Bounded by maxPolls so a wedged batch can't loop forever.
export async function pollUntilEnded(batchId: string, deps: PollDeps): Promise<BatchInfo> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;

  for (let i = 0; i < maxPolls; i++) {
    const info = await deps.batch.get(batchId);
    if (info.processing_status === "ended") return info;
    deps.log?.(
      `  batch ${batchId}: ${info.processing_status}` +
        (info.request_counts ? ` ${JSON.stringify(info.request_counts)}` : ""),
    );
    await deps.sleep(intervalMs);
  }
  throw new Error(`batch ${batchId} did not end within ${maxPolls} polls`);
}
