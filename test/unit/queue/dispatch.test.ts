import { describe, expect, it, vi } from "vitest";
import { dispatchQueueMessage } from "../../../src/index";
import { DeferPaidWorkError } from "../../../src/control-plane/processing-leases";
import { PROCESSING_DEFER_DELAY_SECONDS } from "../../../src/control-plane/constants";
import { RateLimitedError } from "../../../src/modules/http-retry";
import type { ProcessReadingArgs } from "../../../src/process-reading";

function fakeMessage(attempts = 1): Message<ProcessReadingArgs> {
  return {
    id: "m_1",
    timestamp: new Date(),
    body: {
      id: "rd_TEST",
      url: "https://example.com/x",
      urlHash: "a".repeat(64),
      createdAt: "2026-05-07T12:00:00.000Z",
      keyPrefix: "readings/2026/05/07T120000Z-rd_TEST",
    },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<ProcessReadingArgs>;
}

describe("dispatchQueueMessage", () => {
  it("acks on success", async () => {
    const msg = fakeMessage();
    await dispatchQueueMessage(msg, async () => {});
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("acks on application errors so re-delivery does not repeat them", async () => {
    const msg = fakeMessage();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await dispatchQueueMessage(msg, async () => {
      throw new Error("R2 hiccup");
    });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("retries with the upstream's Retry-After (rounded up) on RateLimitedError", async () => {
    const msg = fakeMessage();
    await dispatchQueueMessage(msg, async () => {
      throw new RateLimitedError(429, 12_500, "https://api.anthropic.com/v1/messages");
    });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 13 });
  });

  it("uses an exponential default when Retry-After is missing (attempts=1 → 30s)", async () => {
    const msg = fakeMessage(1);
    await dispatchQueueMessage(msg, async () => {
      throw new RateLimitedError(429, null, "https://api.openai.com/v1/embeddings");
    });
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it("doubles the default per attempt up to 300s", async () => {
    const msg2 = fakeMessage(2);
    await dispatchQueueMessage(msg2, async () => {
      throw new RateLimitedError(429, null, "https://api.openai.com/v1/embeddings");
    });
    expect(msg2.retry).toHaveBeenCalledWith({ delaySeconds: 60 });

    const msg5 = fakeMessage(5);
    await dispatchQueueMessage(msg5, async () => {
      throw new RateLimitedError(429, null, "https://api.openai.com/v1/embeddings");
    });
    // 30 * 2^4 = 480, capped at 300.
    expect(msg5.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });

  it("clamps Retry-After to the queue's 12-hour ceiling", async () => {
    const msg = fakeMessage();
    await dispatchQueueMessage(msg, async () => {
      throw new RateLimitedError(429, 24 * 60 * 60 * 1000, "https://api.anthropic.com/v1/messages");
    });
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 43_200 });
  });

  it("never falls below a 1-second delay", async () => {
    const msg = fakeMessage();
    await dispatchQueueMessage(msg, async () => {
      throw new RateLimitedError(429, 0, "https://api.anthropic.com/v1/messages");
    });
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 1 });
  });

  it("defer_paid_work delayed-sends the same envelope then acks without retry", async () => {
    const msg = fakeMessage();
    const sendDelayed = vi.fn(async () => {});
    await dispatchQueueMessage(
      msg,
      async () => {
        throw new DeferPaidWorkError();
      },
      { sendDelayed },
    );
    expect(sendDelayed).toHaveBeenCalledOnce();
    expect(sendDelayed).toHaveBeenCalledWith(msg.body, PROCESSING_DEFER_DELAY_SECONDS);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("retries the current message when delayed send fails", async () => {
    const msg = fakeMessage();
    const sendDelayed = vi.fn(async () => {
      throw new Error("queue send failed");
    });
    await dispatchQueueMessage(
      msg,
      async () => {
        throw new DeferPaidWorkError();
      },
      { sendDelayed },
    );
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: PROCESSING_DEFER_DELAY_SECONDS });
    expect(msg.ack).not.toHaveBeenCalled();
  });
});
