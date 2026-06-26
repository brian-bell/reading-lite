import { describe, expect, it, vi } from "vitest";
import { enforceSoleWriter, soleWriterGuard } from "../../../scripts/corpus-lib/sole-writer";

describe("soleWriterGuard", () => {
  it("refuses an --execute run that has not acknowledged sole-writer status", () => {
    const v = soleWriterGuard({ execute: true, acknowledged: false, tool: "corpus-ingest" });
    expect(v.proceed).toBe(false);
    expect(v.message).toMatch(/--sole-writer/);
    expect(v.message).toMatch(/corpus-ingest/);
    expect(v.message).not.toMatch(/by-url slot unclaimed/);
  });

  it("proceeds with a loud banner once sole-writer is acknowledged", () => {
    const v = soleWriterGuard({ execute: true, acknowledged: true, tool: "corpus-recover --batch" });
    expect(v.proceed).toBe(true);
    // The banner names the tool and warns that sole-writer mode is still required
    // while recover-batch parity remains incomplete.
    expect(v.message).toMatch(/SOLE-WRITER/);
    expect(v.message).toMatch(/corpus-recover --batch/);
  });

  it("never blocks a dry-run — it submits nothing, so there is no race to guard", () => {
    const unack = soleWriterGuard({ execute: false, acknowledged: false, tool: "corpus-ingest" });
    expect(unack.proceed).toBe(true);
    expect(unack.message).toBe("");

    const ack = soleWriterGuard({ execute: false, acknowledged: true, tool: "corpus-ingest" });
    expect(ack.proceed).toBe(true);
    expect(ack.message).toBe("");
  });
});

describe("enforceSoleWriter (the CLI glue)", () => {
  it("writes the refusal and exits 2 when an --execute run is not acknowledged", () => {
    const write = vi.fn();
    const exit = vi.fn();
    enforceSoleWriter({ execute: true, acknowledged: false, tool: "corpus-ingest" }, { write, exit });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/--sole-writer/));
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("writes the banner but does not exit once acknowledged", () => {
    const write = vi.fn();
    const exit = vi.fn();
    enforceSoleWriter({ execute: true, acknowledged: true, tool: "corpus-ingest" }, { write, exit });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/SOLE-WRITER/));
    expect(exit).not.toHaveBeenCalled();
  });

  it("stays silent and does not exit on a dry-run", () => {
    const write = vi.fn();
    const exit = vi.fn();
    enforceSoleWriter({ execute: false, acknowledged: false, tool: "corpus-ingest" }, { write, exit });
    expect(write).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
