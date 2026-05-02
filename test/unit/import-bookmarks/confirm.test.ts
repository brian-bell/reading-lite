import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirm } from "../../../scripts/import-bookmarks-lib/confirm";

function streams(input: string) {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { input: Readable.from([input]), output: writable, chunks };
}

describe("confirm", () => {
  it("returns true without reading input when yes is set", async () => {
    const { input, output, chunks } = streams("");
    const result = await confirm("Continue?", { yes: true, input, output });
    expect(result).toBe(true);
    expect(chunks.join("")).toBe("");
  });

  it("returns true on 'y'", async () => {
    const { input, output } = streams("y\n");
    expect(await confirm("Continue?", { yes: false, input, output })).toBe(true);
  });

  it("returns true on 'Y'", async () => {
    const { input, output } = streams("Y\n");
    expect(await confirm("Continue?", { yes: false, input, output })).toBe(true);
  });

  it("returns true on 'yes'", async () => {
    const { input, output } = streams("yes\n");
    expect(await confirm("Continue?", { yes: false, input, output })).toBe(true);
  });

  it("returns false on 'n'", async () => {
    const { input, output } = streams("n\n");
    expect(await confirm("Continue?", { yes: false, input, output })).toBe(false);
  });

  it("returns false on empty input (default no)", async () => {
    const { input, output } = streams("\n");
    expect(await confirm("Continue?", { yes: false, input, output })).toBe(false);
  });

  it("writes the prompt to the output stream", async () => {
    const { input, output, chunks } = streams("y\n");
    await confirm("Continue?", { yes: false, input, output });
    expect(chunks.join("")).toContain("Continue?");
  });
});
