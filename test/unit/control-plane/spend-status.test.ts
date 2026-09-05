import { describe, expect, it } from "vitest";
import { readSpendStatus } from "../../../src/control-plane/spend-status";
const tenant = "usr_550e8400-e29b-41d4-a716-446655440000";
const now = Date.parse("2026-09-05T23:59:59Z");
describe("spend status", () => {
  it("reads authoritative counters without touching operation records or sweeping holds", async () => {
    const keys: string[] = [];
    const store = {
      get: async (key: string) => {
        keys.push(key);
        return { microdollars: key.startsWith("spend:day:") ? 900 : 400 };
      },
    } as Pick<DurableObjectStorage, "get">;
    expect(await readSpendStatus(store, now, tenant)).toEqual({
      dayKey: "2026-09-05",
      observedAtMs: now,
      resetAtMs: Date.parse("2026-09-06T00:00:00Z"),
      globalChargedMicrodollars: 900,
      tenantId: tenant,
      tenantChargedMicrodollars: 400,
    });
    expect(keys).toEqual([
      "spend:day:2026-09-05",
      `spend:tenant:${tenant}:day:2026-09-05`,
    ]);
  });
  it("an absent current-day counter is zero", async () => {
    expect(
      await readSpendStatus(
        { get: async () => undefined } as unknown as Pick<
          DurableObjectStorage,
          "get"
        >,
        now,
      ),
    ).toMatchObject({ globalChargedMicrodollars: 0 });
  });
  it("does not report malformed storage as zero", async () => {
    await expect(
      readSpendStatus(
        { get: async () => ({ microdollars: -1 }) } as unknown as Pick<
          DurableObjectStorage,
          "get"
        >,
        now,
      ),
    ).rejects.toThrow();
  });
});
