export interface ReprocessBodyOpts {
  force: boolean;
  email: boolean | undefined;
}

export function buildReprocessBody(opts: ReprocessBodyOpts): string {
  const out: Record<string, unknown> = {};
  if (opts.force) out.force = true;
  if (opts.email !== undefined) out.email = opts.email;
  return JSON.stringify(out);
}
