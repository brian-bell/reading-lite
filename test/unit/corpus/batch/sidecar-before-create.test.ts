import { describe, expect, it, vi } from "vitest";
import { runBatch } from "../../../../scripts/corpus-lib/batch/run";
import type { PersistedSidecar } from "../../../../scripts/corpus-lib/batch/types";
import { harness, manifest, row } from "./run-harness";

describe("runBatch — spend admission", () => {
  const OP_ID = "operator:anthropic-batch:op-1";

  function traced(h: ReturnType<typeof harness>) {
    const events: string[] = [];
    const saved: PersistedSidecar[] = [];
    const rpc = h.deps.spend.rpc;
    h.deps.spend = {
      ...h.deps.spend,
      rpc: async (body) => {
        events.push(String(body.kind));
        return rpc(body);
      },
    };
    const save = h.deps.saveSidecar;
    h.deps.saveSidecar = async (s) => {
      events.push(`sidecar:${s.phase}`);
      saved.push(s);
      await save(s);
    };
    const create = h.batch.create;
    h.batch.create = vi.fn(async (requests: Array<{ custom_id: string }>) => {
      events.push("create");
      return create(requests);
    });
    return { events, saved };
  }

  it("reserves and marks before the first pending sidecar, which precedes create, then settles the results", async () => {
    const h = harness({ rd_a: manifest("rd_a") });
    const { events, saved } = traced(h);

    const result = await runBatch([row("rd_a")], h.deps);

    expect(events).toEqual([
      "reserve_spend",
      "mark_spend_dispatched",
      "sidecar:activating",
      "sidecar:creating",
      "create",
      "sidecar:submitted",
      "settle_spend",
    ]);
    expect(saved.map((s) => s.spend?.opId)).toEqual([OP_ID, OP_ID, OP_ID]);
    // 5 input × 500 + 2 output × 2,500 hundredths of a µ$, × 1.1 geography.
    expect(result.spend).toEqual({
      state: "settled",
      actualMicrodollars: 83,
      maxMicrodollars: saved[0]!.spend!.quote.maxMicrodollars,
    });
    expect(h.authority.calls.at(-1)).toMatchObject({ opId: OP_ID, actualMicrodollars: 83 });
  });
});
