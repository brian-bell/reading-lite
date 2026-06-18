import { describe, expect, it, vi } from "vitest";
import { handleDeadLetter } from "../../../src/index";
import type { ProcessReadingArgs } from "../../../src/process-reading";

function fakeMessage(): Message<ProcessReadingArgs> {
  return {
    id: "m_dlq",
    timestamp: new Date(),
    body: {
      id: "rd_TEST",
      url: "https://example.com/x",
      urlHash: "a".repeat(64),
      createdAt: "2026-05-07T12:00:00.000Z",
      keyPrefix: "readings/2026/05/07T120000Z-rd_TEST",
    },
    attempts: 4,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<ProcessReadingArgs>;
}

describe("handleDeadLetter", () => {
  it("marks the reading failed and acks (never retries; DLQ is terminal)", async () => {
    const msg = fakeMessage();
    const mark = vi.fn(async () => {});
    await handleDeadLetter(msg, mark);
    expect(mark).toHaveBeenCalledOnce();
    expect(mark).toHaveBeenCalledWith(msg.body);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("acks even when marking fails, so the message cannot loop in the DLQ", async () => {
    const msg = fakeMessage();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const mark = vi.fn(async () => {
      throw new Error("R2 hiccup");
    });
    await handleDeadLetter(msg, mark);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});
