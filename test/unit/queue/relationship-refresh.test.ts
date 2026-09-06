import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../../../src/index";

afterEach(() => vi.restoreAllMocks());

const queues = ["reading-lite-refresh", "reading-lite-staging-refresh"];

describe("relationship refresh plumbing", () => {
  for (const queue of queues) {
    for (const gate of [undefined, "0", "1"]) {
      it(`${queue} acknowledges without accessing services with gate ${gate}`, async () => {
        const log = vi.spyOn(console, "warn").mockImplementation(() => {});
        const ack = vi.fn();
        const retry = vi.fn();
        const env = new Proxy({ RELATIONSHIP_REFRESH: gate }, {
          get(target, key) {
            if (key === "RELATIONSHIP_REFRESH") return target.RELATIONSHIP_REFRESH;
            throw new Error(`unexpected env access: ${String(key)}`);
          },
        }) as Env;
        await worker.queue({ queue, messages: [{ body: null, ack, retry }] } as unknown as MessageBatch<unknown>, env);
        expect(ack).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledTimes(gate === "1" ? 1 : 0);
      });
    }
    it(`${queue}-dlq logs and acknowledges without reading payload or env`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const ack = vi.fn();
      const msg = { ack, get body() { throw new Error("must not read payload"); } };
      const env = new Proxy({}, { get() { throw new Error("must not access env"); } }) as Env;
      await worker.queue({ queue: `${queue}-dlq`, messages: [msg] } as unknown as MessageBatch<unknown>, env);
      expect(ack).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
    });
  }
});
