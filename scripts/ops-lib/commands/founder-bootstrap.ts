// `ops founder bootstrap` — idempotently create or resolve the founder user,
// default settings, explicit placeholder tenant limits, and import
// READER_API_TOKEN as a 90-day legacy-format API token.
//
// Plan-first via the library's own apply flag: a mode-less run resolves and
// prints the would-write actions without writing; --execute applies. A
// production write additionally requires --confirm-production.

import {
  HelpRequested,
  openPostgresControlPlane,
  parseFounderBootstrapArgs,
  resolveEnvVars,
  runFounderBootstrap,
  type BootstrapEnvName,
  type FounderBootstrapCliArgs,
  type FounderBootstrapDeps,
} from "../../lib/founder-bootstrap";
import { UsageError, type BaseDeps, type CommandDefinition, type CommandIo } from "../contract";

export interface FounderBootstrapCommandDeps extends BaseDeps {
  resolveEnvVars: (env: BootstrapEnvName) => Record<string, string | undefined>;
  openDb: FounderBootstrapDeps["openDb"];
  now: () => number;
}

async function runFounderBootstrapCommand(
  argv: string[],
  deps: FounderBootstrapCommandDeps,
): Promise<number> {
  let args: FounderBootstrapCliArgs;
  try {
    args = parseFounderBootstrapArgs(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      // The dispatcher already intercepts --help; this only covers -h-less
      // parse paths reaching the library's own help signal.
      throw new UsageError("help requested");
    }
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const result = await runFounderBootstrap(args, {
    envVars: deps.resolveEnvVars(args.env),
    nowMs: deps.now(),
    write: (line) => deps.io.stderr(line.replace(/\n$/, "")),
    openDb: deps.openDb,
  });
  return result.exitCode;
}

export const founderBootstrapCommand: CommandDefinition<FounderBootstrapCommandDeps> = {
  group: "founder",
  name: "bootstrap",
  summary: "Create/resolve the founder principal and import the legacy token",
  safety: "plan-first",
  helpText: `Usage: npm run ops -- founder bootstrap [--email <addr>] [--env local|staging|production] [--database-url-env NAME] [--execute] [--confirm-production]

Idempotently creates or resolves the founder user, default settings,
explicit placeholder tenant limits, and imports READER_API_TOKEN as a
90-day legacy-format API token. Plans by default.

Options:
  --email                  Founder address. Default: FOUNDER_EMAIL.
  --env                    local (default), staging, or production.
  --database-url-env       Staging and production: the environment variable
                           holding a DIRECT PostgreSQL connection string,
                           checked against the environment's database
                           pairing. Staging: STAGING_DATABASE_URL or
                           NEON_REHEARSAL_DATABASE_URL. Production:
                           PRODUCTION_DATABASE_URL or NEON_MAIN_DATABASE_URL.
                           Default: whichever accepted name is set. Local
                           uses the dev database (READING_LITE_DATABASE_URL
                           or compose).
  --execute                Apply writes. Otherwise prints the plan.
  --confirm-production     Required with --execute --env production.
  --help                   Show this message.

Credentials: AUTH_ROOT_SECRET and READER_API_TOKEN from the environment
or .dev.vars / .stg.vars / .prd.vars. The control plane is PostgreSQL
(ADR 0005); apply its migrations first with \`npm run ops -- db migrate\`
(staging: \`npm run ops -- staging setup\` migrates it).`,
  defaultDeps: (io: CommandIo): FounderBootstrapCommandDeps => ({
    io,
    resolveEnvVars,
    openDb: openPostgresControlPlane,
    now: () => Date.now(),
  }),
  run: runFounderBootstrapCommand,
};
