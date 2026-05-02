import * as readline from "node:readline/promises";

export interface ConfirmOpts {
  yes: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

// Asks a y/N question and returns whether the user agreed. Defaults to no on
// empty / unrecognized input. Streams are injectable so tests don't have to
// touch real stdio.
export async function confirm(question: string, opts: ConfirmOpts): Promise<boolean> {
  if (opts.yes) return true;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
