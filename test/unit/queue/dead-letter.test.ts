import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { fromD1 } from "../../../src/control-plane/db";
import { handleDeadLetter } from "../../../src/index";
import { buildKeyPrefix } from "../../../src/modules/stores/reading-store";
import type { ProcessReadingArgs } from "../../../src/process-reading";

const TENANT = "usr_550e8400-e29b-41d4-a716-446655440000";
const TOKEN = "tok_550e8400-e29b-41d4-a716-446655440000";
const READING_ID = "rd_0123456789";
const JOB_URL = "https://example.com/x";
const JOB_CREATED = "2026-05-07T12:00:00.000Z";
const JOB_URL_HASH = "54cef8f42f3f31ad349075022cd36ce1a378d039c1df7af45d61d693d9a35c6a";

const JOB: ProcessReadingArgs = {
  id: READING_ID,
  url: JOB_URL,
  urlHash: JOB_URL_HASH,
  createdAt: JOB_CREATED,
  keyPrefix: buildKeyPrefix(READING_ID, JOB_CREATED),
};

function fakeMessage(
  body: unknown = {
    version: 1,
    tenant: { tenantId: TENANT },
    actor: { kind: "api_token", credentialId: TOKEN },
    job: JOB,
  },
): Message<unknown> {
  return {
    id: "m_dlq",
    timestamp: new Date(),
    body,
    attempts: 4,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown>;
}

function deadLetterDeps(mark: (body: ProcessReadingArgs, tenant: { tenantId: string }) => Promise<void>) {
  return {
    db: fromD1(env.CONTROL_PLANE),
    nowMs: Date.now(),
    mark,
  };
}

describe("handleDeadLetter", () => {
  it("marks the reading failed and acks (never retries; DLQ is terminal)", async () => {
    const msg = fakeMessage();
    const mark = vi.fn(async () => {});
    await handleDeadLetter(msg, deadLetterDeps(mark));
    expect(mark).toHaveBeenCalledOnce();
    expect(mark).toHaveBeenCalledWith(JOB, { tenantId: TENANT });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("acks an unversioned leftover without marking, so drain-only cutover cannot process it", async () => {
    const msg = fakeMessage(JOB);
    const mark = vi.fn(async () => {});
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleDeadLetter(msg, deadLetterDeps(mark));
    expect(mark).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("acks without marking when tenant admission fails", async () => {
    const msg = fakeMessage({
      version: 1,
      tenant: { tenantId: "usr_11111111-1111-4111-8111-111111111111" },
      actor: { kind: "api_token", credentialId: TOKEN },
      job: JOB,
    });
    const mark = vi.fn(async () => {});
    await handleDeadLetter(msg, deadLetterDeps(mark));
    expect(mark).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it("acks even when marking fails, so the message cannot loop in the DLQ", async () => {
    const msg = fakeMessage();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const mark = vi.fn(async () => {
      throw new Error("R2 hiccup");
    });
    await handleDeadLetter(msg, deadLetterDeps(mark));
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("acks even when admission throws, so the message cannot loop in the DLQ", async () => {
    const msg = fakeMessage();
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const mark = vi.fn(async () => {});
    const db = {
      first: async () => {
        throw new Error("D1 hiccup");
      },
      all: async () => [],
      batch: async () => [],
      run: async () => ({ changes: 0 }),
    };
    await handleDeadLetter(msg, { db, nowMs: Date.now(), mark });
    expect(mark).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});
