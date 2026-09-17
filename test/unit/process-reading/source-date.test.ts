import { describe, expect, it } from "vitest";
import { sourceDateFromPrior } from "../../../src/process-reading";
import type { Manifest } from "../../../src/schemas/manifest";

const PREFIX = "readings/2026/04/26T200000Z-rd_TEST";

function args(over: { preserveReadyManifest?: Manifest } = {}) {
  return { keyPrefix: PREFIX, ...over };
}

function reader(readManifest: () => Promise<Manifest | null>) {
  return { readManifest: async () => readManifest() };
}

function pending(over: Partial<Manifest> = {}): Manifest {
  return {
    id: "rd_TEST",
    url: "https://example.com/x",
    url_hash: "a".repeat(64),
    status: "pending",
    content_type: "application/octet-stream",
    content_status: "captured",
    content_bytes: 0,
    content_sha256: "0".repeat(64),
    created_at: "2026-04-26T20:00:00.000Z",
    updated_at: "2026-04-26T20:00:00.000Z",
    ...over,
  };
}

describe("sourceDateFromPrior", () => {
  it("carries a date from the current pending and omits it when none is stored", async () => {
    await expect(
      sourceDateFromPrior(reader(async () => pending({ source_date: "2024-03-15" })), args()),
    ).resolves.toBe("2024-03-15");
    await expect(sourceDateFromPrior(reader(async () => pending()), args())).resolves.toBeUndefined();
    await expect(sourceDateFromPrior(reader(async () => null), args())).resolves.toBeUndefined();
  });

  it("prefers the current pending over a preserved ready snapshot", async () => {
    await expect(
      sourceDateFromPrior(
        reader(async () => pending({ source_date: "2024-03-15" })),
        args({ preserveReadyManifest: pending({ status: "ready", source_date: "2020-01-01" }) }),
      ),
    ).resolves.toBe("2024-03-15");
  });

  it("recovers a preserved date when the prior-manifest read throws", async () => {
    await expect(
      sourceDateFromPrior(reader(async () => {
        throw new Error("R2 hiccup");
      }), args({
        preserveReadyManifest: pending({ status: "ready", source_date: "2024-03-15" }),
      })),
    ).resolves.toBe("2024-03-15");
  });

  it("fails closed on a prior-manifest read error when no preserved date can recover it", async () => {
    const error = new Error("R2 hiccup");
    await expect(
      sourceDateFromPrior(reader(async () => {
        throw error;
      }), args()),
    ).rejects.toBe(error);

    await expect(
      sourceDateFromPrior(reader(async () => {
        throw error;
      }), args({ preserveReadyManifest: pending({ status: "ready" }) })),
    ).rejects.toBe(error);
  });
});
