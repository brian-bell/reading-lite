// Issue #68: the offline batch tools (corpus-ingest, corpus-recover --batch) do
// not claim the by-url slot until a run *succeeds*, so for the whole in-flight
// window — fetch → embed → the minutes-to-hours Anthropic Message Batch — each
// target URL sits unclaimed. If the realtime writer is live, an online submit
// for the same URL wins the empty by-url slot and races the batch: duplicate
// paid summarization/embedding, duplicate emails, and by-url/by-id/list-row
// pointer thrash (no corruption — the CAS gates prevent that). The mitigation is
// operational: run a batch only with the realtime writer paused/drained. This
// guard makes that discipline enforceable instead of tribal knowledge — a real
// (--execute) batch submit is refused unless the operator explicitly asserts
// sole-writer status with --sole-writer.
export interface SoleWriterVerdict {
  proceed: boolean;
  // Text to print to stderr: the refusal when blocked, the loud banner when
  // proceeding under acknowledgment, "" when there is nothing to say.
  message: string;
}

const RULE = "═".repeat(72);

export function soleWriterGuard(opts: {
  execute: boolean;
  acknowledged: boolean;
  tool: string;
}): SoleWriterVerdict {
  // A dry-run submits nothing, so there is no race to guard.
  if (!opts.execute) return { proceed: true, message: "" };

  if (!opts.acknowledged) {
    return {
      proceed: false,
      message:
        `REFUSED: ${opts.tool} --execute requires --sole-writer.\n` +
        `  This batch path leaves each URL's by-url slot unclaimed for the entire\n` +
        `  in-flight window, so a live realtime writer can race it (duplicate paid\n` +
        `  summarization + embedding, duplicate emails, pointer thrash).\n` +
        `  Pause/drain the realtime writer, then re-run with --sole-writer to confirm\n` +
        `  this script is the only writer.`,
    };
  }
  return {
    proceed: true,
    message:
      `${RULE}\n` +
      `  SOLE-WRITER MODE: ${opts.tool}\n` +
      `  You asserted the realtime writer is paused/drained. This batch submits\n` +
      `  with each by-url slot left unclaimed for the in-flight window; a concurrent\n` +
      `  live writer would duplicate compute + emails and thrash pointers.\n` +
      `${RULE}`,
  };
}

// The single home for the CLI glue: print the verdict's message (if any) and exit
// non-zero on refusal. Both batch front-ends call this with `process` I/O
// injected, so the decision *and* its side effects are unit-testable without
// spawning a subprocess. A refused run exits 2 (matching the cred-failure exit
// code these tools already use).
export function enforceSoleWriter(
  opts: { execute: boolean; acknowledged: boolean; tool: string },
  io: { write: (s: string) => void; exit: (code: number) => void },
): void {
  const verdict = soleWriterGuard(opts);
  if (verdict.message) io.write(verdict.message + "\n");
  if (!verdict.proceed) io.exit(2);
}
