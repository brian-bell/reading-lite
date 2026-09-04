import { describe, expect, it, vi } from "vitest";
import { defaultServices, lookupFromResolvers, nodeDnsLookup } from "../../../src/services";

function codedError(code: string, message = code): Error {
  const error = new Error(message);
  (error as unknown as { code: string }).code = code;
  return error;
}

describe("lookupFromResolvers", () => {
  it("uses resolve4 and resolve6 in parallel and never a lookup() hook", async () => {
    const resolve4 = vi.fn(async () => ["93.184.216.34"]);
    const resolve6 = vi.fn(async () => ["2606:2800:220:1:248:1893:25c8:1946"]);
    const lookup = vi.fn(async () => {
      throw new Error("Workers node:dns.lookup is not implemented");
    });

    const fn = lookupFromResolvers({ resolve4, resolve6 });
    await expect(fn("example.com")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    expect(resolve4).toHaveBeenCalledOnce();
    expect(resolve4).toHaveBeenCalledWith("example.com");
    expect(resolve6).toHaveBeenCalledOnce();
    expect(resolve6).toHaveBeenCalledWith("example.com");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["ENODATA", "ENOTFOUND", "ENOENT"] as const)(
    "tolerates %s on one family when the other has addresses",
    async (code) => {
      const resolve4 = vi.fn(async () => ["1.1.1.1"]);
      const resolve6 = vi.fn(async () => {
        throw codedError(code);
      });

      await expect(lookupFromResolvers({ resolve4, resolve6 })("one-family.example")).resolves.toEqual([
        { address: "1.1.1.1", family: 4 },
      ]);
    },
  );

  it("returns AAAA-only when resolve4 is NODATA", async () => {
    const resolve4 = vi.fn(async () => {
      throw codedError("ENODATA");
    });
    const resolve6 = vi.fn(async () => ["2606:4700:4700::1111"]);

    await expect(lookupFromResolvers({ resolve4, resolve6 })("v6-only.example")).resolves.toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("returns no addresses when both families are NODATA", async () => {
    const resolve4 = vi.fn(async () => {
      throw codedError("ENODATA");
    });
    const resolve6 = vi.fn(async () => {
      throw codedError("ENOTFOUND");
    });

    await expect(lookupFromResolvers({ resolve4, resolve6 })("empty.example")).resolves.toEqual([]);
  });

  it("propagates a hard resolver error when the other family has no addresses", async () => {
    const hard = codedError("ESERVFAIL", "SERVFAIL");
    const resolve4 = vi.fn(async () => {
      throw hard;
    });
    const resolve6 = vi.fn(async () => {
      throw codedError("ENODATA");
    });

    await expect(lookupFromResolvers({ resolve4, resolve6 })("broken.example")).rejects.toBe(hard);
  });

  // A hard error means one family was never vetted, while `fetch` re-resolves
  // and may still connect over it. Returning the other family's addresses would
  // let an attacker whose nameserver fails A queries hide a private A record
  // behind a public AAAA answer, so the guard fails closed instead.
  it("fails closed when one family hard-fails, even if the other resolved", async () => {
    const hard = new Error("timeout");
    const resolve4 = vi.fn(async () => ["8.8.8.8"]);
    const resolve6 = vi.fn(async () => {
      throw hard;
    });

    await expect(
      lookupFromResolvers({ resolve4, resolve6 })("partial.example"),
    ).rejects.toBe(hard);
  });

  it("fails closed when the unvetted family is the one carrying the private record", async () => {
    const hard = new Error("SERVFAIL");
    const resolve4 = vi.fn(async () => {
      throw hard;
    });
    const resolve6 = vi.fn(async () => ["2606:4700:4700::1111"]);

    await expect(
      lookupFromResolvers({ resolve4, resolve6 })("split-answer.example"),
    ).rejects.toBe(hard);
  });
});

describe("defaultServices lookup", () => {
  it("injects the resolve4/resolve6 adapter, not dns.lookup", () => {
    expect(defaultServices().lookup).toBe(nodeDnsLookup);
  });
});
