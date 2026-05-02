import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompter } from "../../../scripts/import-bookmarks-lib/confirm";

function streams(input: string) {
  const chunks: string[] = [];
  const lines = input.split("\n").filter((_, i, arr) => i < arr.length - 1).map((l) => l + "\n");
  let lineIdx = 0;
  const readable = new Readable({ read() {} });
  // Drip-feed input lines: push the next line each time a prompt is written.
  // The push is deferred a tick so it lands after rl.question() finishes
  // wiring up its line listener — pushing synchronously goes into a buffer
  // that the next question() call doesn't observe.
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      if (lineIdx < lines.length) {
        const next = lines[lineIdx++]!;
        setImmediate(() => readable.push(next));
      }
      cb();
    },
  });
  return { input: readable, output: writable, chunks };
}

describe("createPrompter / ask", () => {
  it("defaults to 'yes' on empty input", async () => {
    const { input, output } = streams("\n");
    const p = createPrompter({ input, output });
    expect(await p.ask("submit?")).toBe("yes");
    p.close();
  });

  it("returns 'yes' for y/Y/yes", async () => {
    for (const answer of ["y\n", "Y\n", "yes\n", "YES\n"]) {
      const { input, output } = streams(answer);
      const p = createPrompter({ input, output });
      expect(await p.ask("submit?")).toBe("yes");
      p.close();
    }
  });

  it("returns 'no' for n/N/no", async () => {
    for (const answer of ["n\n", "N\n", "no\n"]) {
      const { input, output } = streams(answer);
      const p = createPrompter({ input, output });
      expect(await p.ask("submit?")).toBe("no");
      p.close();
    }
  });

  it("returns 'quit' for q/Q/quit", async () => {
    for (const answer of ["q\n", "Q\n", "quit\n"]) {
      const { input, output } = streams(answer);
      const p = createPrompter({ input, output });
      expect(await p.ask("submit?")).toBe("quit");
      p.close();
    }
  });

  it("re-prompts on unrecognized input", async () => {
    const { input, output, chunks } = streams("huh?\nyes\n");
    const p = createPrompter({ input, output });
    expect(await p.ask("submit?")).toBe("yes");
    p.close();
    expect(chunks.join("").match(/submit\?/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("writes the prompt to the output stream", async () => {
    const { input, output, chunks } = streams("\n");
    const p = createPrompter({ input, output });
    await p.ask("submit?");
    p.close();
    expect(chunks.join("")).toContain("submit?");
  });

  it("answers multiple questions on the same prompter without losing input", async () => {
    const { input, output } = streams("y\nn\nq\n");
    const p = createPrompter({ input, output });
    expect(await p.ask("first?")).toBe("yes");
    expect(await p.ask("second?")).toBe("no");
    expect(await p.ask("third?")).toBe("quit");
    p.close();
  });
});
