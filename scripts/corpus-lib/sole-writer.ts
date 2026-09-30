// Issue #68: the offline batch tools still require an operational sole-writer
// window. Both paths eagerly claim activated by-url slots, but those claims are
// defense-in-depth rather than permission to overlap the realtime writer. This
// guard makes the pause/drain discipline enforceable instead of tribal
// knowledge — a real (--execute) batch submit is refused unless the operator
// explicitly asserts sole-writer status with --sole-writer.
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
        `  Eager by-url claims are defense-in-depth, not permission to overlap\n` +
        `  the realtime writer; concurrent writes can still duplicate compute or\n` +
        `  make terminal ownership harder to reason about.\n` +
        `  Pause/drain the realtime writer, then re-run with --sole-writer to confirm\n` +
        `  this script is the only writer.`,
    };
  }
  return {
    proceed: true,
    message:
      `${RULE}\n` +
      `  SOLE-WRITER MODE: ${opts.tool}\n` +
      `  You asserted the realtime writer is paused/drained. Eager by-url claims\n` +
      `  are defense-in-depth; this run still excludes concurrent live writers.\n` +
      `${RULE}`,
  };
}
