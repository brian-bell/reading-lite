// Issue #68: the offline batch tools still require an operational sole-writer
// window. Fresh ingest now eagerly claims activated by-url slots, but
// corpus-recover parity is still a separate slice; a live realtime writer can
// still race incomplete recover-batch ownership states. This guard makes the
// pause/drain discipline enforceable instead of tribal knowledge
// — a real (--execute) batch submit is refused unless the operator explicitly
// asserts sole-writer status with --sole-writer.
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
        `  Offline batch ownership is not fully race-proof across all paths yet,\n` +
        `  so a live realtime writer can still duplicate compute/emails or thrash\n` +
        `  pointers during incomplete recover-batch slices.\n` +
        `  Pause/drain the realtime writer, then re-run with --sole-writer to confirm\n` +
        `  this script is the only writer.`,
    };
  }
  return {
    proceed: true,
    message:
      `${RULE}\n` +
      `  SOLE-WRITER MODE: ${opts.tool}\n` +
      `  You asserted the realtime writer is paused/drained. Offline batch ownership\n` +
      `  still has incomplete recover-batch parity, so a concurrent live\n` +
      `  writer could duplicate compute + emails or thrash pointers.\n` +
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
