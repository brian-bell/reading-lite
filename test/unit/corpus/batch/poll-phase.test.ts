import { describe, expect, it, vi } from "vitest";
import { pollUntilEnded } from "../../../../scripts/corpus-lib/batch/poll-phase";

function batchReturning(statuses: string[]) {
  let i = 0;
  return {
    create: vi.fn(),
    results: vi.fn(),
    get: vi.fn(async () => {
      const processing_status = statuses[Math.min(i, statuses.length - 1)]!;
      i++;
      return { id: "msgbatch_1", processing_status, results_url: processing_status === "ended" ? "https://r" : null };
    }),
  };
}

describe("pollUntilEnded", () => {
  it("returns immediately when the batch is already ended (no sleep)", async () => {
    const batch = batchReturning(["ended"]);
    const sleep = vi.fn(async () => {});
    const info = await pollUntilEnded("msgbatch_1", { batch: batch as any, sleep });
    expect(info.processing_status).toBe("ended");
    expect(info.results_url).toBe("https://r");
    expect(sleep).not.toHaveBeenCalled();
    expect(batch.get).toHaveBeenCalledTimes(1);
  });

  it("polls with sleeps until the batch ends", async () => {
    const batch = batchReturning(["in_progress", "in_progress", "ended"]);
    const sleep = vi.fn(async () => {});
    const info = await pollUntilEnded("msgbatch_1", { batch: batch as any, sleep, intervalMs: 5000 });
    expect(info.processing_status).toBe("ended");
    expect(batch.get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("throws if the batch never ends within maxPolls", async () => {
    const batch = batchReturning(["in_progress"]);
    const sleep = vi.fn(async () => {});
    await expect(
      pollUntilEnded("msgbatch_1", { batch: batch as any, sleep, maxPolls: 3 }),
    ).rejects.toThrow(/did not end/i);
    expect(batch.get).toHaveBeenCalledTimes(3);
  });
});
