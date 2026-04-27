import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotVars } from "../../../scripts/lib/dotvars";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotvars-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(name: string, contents: string): Promise<string> {
  const p = path.join(tmp, name);
  await fs.writeFile(p, contents, "utf8");
  return p;
}

describe("loadDotVars", () => {
  it("returns {} when the file is missing", () => {
    expect(loadDotVars(path.join(tmp, "nope.vars"))).toEqual({});
  });

  it("parses KEY=value lines", async () => {
    const p = await write(".vars", "FOO=bar\nBAZ=qux\n");
    expect(loadDotVars(p)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips blank lines and # comments", async () => {
    const p = await write(".vars", "# header\n\nFOO=bar\n  # indented comment\nBAZ=qux\n");
    expect(loadDotVars(p)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matching single or double quotes", async () => {
    const p = await write(".vars", `A="double"\nB='single'\nC="mixed'\nD=plain\n`);
    expect(loadDotVars(p)).toEqual({
      A: "double",
      B: "single",
      C: `"mixed'`,
      D: "plain",
    });
  });

  it("tolerates trailing whitespace and CRLF line endings", async () => {
    const p = await write(".vars", "FOO=bar  \r\nBAZ=qux\r\n");
    expect(loadDotVars(p)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores lines without an equals sign or with empty key", async () => {
    const p = await write(".vars", "no-equals-here\n=novalue\nFOO=bar\n");
    expect(loadDotVars(p)).toEqual({ FOO: "bar" });
  });
});
