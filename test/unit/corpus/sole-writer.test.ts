import { describe, expect, it } from "vitest";
import { soleWriterGuard } from "../../../scripts/corpus-lib/sole-writer";

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
    // The banner names the tool and explains why eager claims do not replace
    // the operational sole-writer window.
    expect(v.message).toMatch(/SOLE-WRITER/);
    expect(v.message).toMatch(/corpus-recover --batch/);
    expect(v.message).toMatch(/defense-in-depth/);
    expect(v.message).not.toMatch(/incomplete recover/);
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
