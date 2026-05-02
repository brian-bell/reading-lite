import * as readline from "node:readline";

export type Decision = "yes" | "no" | "quit";

export interface Prompter {
  ask(question: string): Promise<Decision>;
  close(): void;
}

export interface PrompterOpts {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

// Wraps node:readline with a Y/n/q answer model. Empty input is "yes" so the
// user can rip through a list with the Enter key. Unrecognized answers
// re-prompt rather than fall through to a silent default. EOF is "quit".
//
// Buffers lines into an internal queue rather than calling rl.question()
// directly. readline closes itself when stdin EOFs (which happens immediately
// when input is piped) and any subsequent question() promise rejects, even
// if more lines were already read into readline's own buffer. The queue keeps
// us serving from buffered lines after readline has closed.
export function createPrompter(opts: PrompterOpts = {}): Prompter {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const rl = readline.createInterface({ input, output });

  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });

  function nextLine(): Promise<string | null> {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  }

  return {
    async ask(question: string): Promise<Decision> {
      while (true) {
        output.write(`${question} `);
        const raw = await nextLine();
        if (raw === null) return "quit";
        const norm = raw.trim().toLowerCase();
        if (norm === "" || norm === "y" || norm === "yes") return "yes";
        if (norm === "n" || norm === "no") return "no";
        if (norm === "q" || norm === "quit") return "quit";
        output.write(`(answer y, n, or q)\n`);
      }
    },
    close() {
      rl.close();
    },
  };
}
