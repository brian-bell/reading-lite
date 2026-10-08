// Runs vitest with minimal output to keep agent/CI logs small, while never
// hiding a real failure:
//   - On success: prints only the summary block (file/test counts, duration).
//   - On failure: prints the full output, minus known-harmless noise lines.
// Vitest's exit code is always preserved. Extra args pass through, e.g.
//   npm run test:quiet -- test/unit/pipeline-guards.test.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Workers-pool spam that carries no signal — dropped on every run.
const NOISE = [
  /CODE_MOVED for unknown code block/,
  /MF-Vitest-Source/,
  /workerd\/jsg\//,
  /^\[vpw:(debug|info)\]/,
  /^Using secrets defined in \.dev\.vars/,
];

// The only lines worth keeping when the run is green.
const SUMMARY = [/^\s*(RUN\b|Test Files|Tests|Start at|Duration)/];

const matches = (line, res) => res.some((re) => re.test(line));

const vitestBin = new URL(
  "../node_modules/.bin/vitest",
  import.meta.url,
).pathname;

const child = spawn(
  vitestBin,
  ["run", "--reporter=dot", ...process.argv.slice(2)],
  { stdio: ["inherit", "pipe", "pipe"] },
);

// Buffer non-noise lines so we can decide how much to print once we know the
// exit code. Runs are short (seconds), so buffering costs nothing meaningful.
const lines = [];
const collect = (readable) =>
  new Promise((resolve) => {
    createInterface({ input: readable })
      .on("line", (line) => {
        if (!matches(line, NOISE)) lines.push(line);
      })
      .on("close", resolve);
  });

const drained = Promise.all([collect(child.stdout), collect(child.stderr)]);

child.on("close", async (code, signal) => {
  await drained;
  const failed = signal || code !== 0;
  const out = failed ? lines : lines.filter((l) => matches(l, SUMMARY));
  if (out.length) process.stdout.write(out.join("\n") + "\n");
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
