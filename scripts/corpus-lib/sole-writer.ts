// Issue #68: the offline batch tools coordinate ownership outside the Worker.
// corpus-ingest now eagerly claims success-bound targets before batch creation,
// but recover-batch parity and failure-path claim release are separate slices.
// Until all batch paths share the Worker's ownership guarantees, the mitigation
// is operational: run a batch only with the realtime writer paused/drained. This
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
        `  Offline batch paths still have ownership windows that require the realtime\n` +
        `  writer to be paused/drained (recover-batch parity and failure-release\n` +
        `  slices are not complete).\n` +
        `  Pause/drain the realtime writer, then re-run with --sole-writer to confirm\n` +
        `  this script is the only writer.`,
    };
  }
  return {
    proceed: true,
    message:
      `${RULE}\n` +
      `  SOLE-WRITER MODE: ${opts.tool}\n` +
      `  You asserted the realtime writer is paused/drained while this offline\n` +
      `  batch owns the write path.\n` +
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
