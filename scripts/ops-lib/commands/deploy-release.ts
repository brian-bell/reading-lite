/** Opt-in operator gate only. Compose existing wipe and Worker deploy checks;
 * never move evidence validation past the first production write. */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { captureProvenance, ShaSchema, validateReleaseEvidence, type Provenance } from "../../lib/release-evidence";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";
import { deployWipeCheckCommand } from "./deploy-wipe-check";
import { deployWorkerCommand } from "./deploy-worker";

interface Deps extends BaseDeps {
  read(path: string): Promise<string>;
  provenance(sha: string): Promise<Provenance>;
  wipe(sha: string): Promise<number>;
  deploy(sha: string): Promise<number>;
}
export const deployReleaseCommand: CommandDefinition<Deps> = {
  group: "deploy", name: "release", safety: "plan-first",
  summary: "Explicit token-drill evidence gate before production Worker release",
  helpText: `Usage: npm run ops -- deploy release --check token-revocation --evidence <result.json> --release-sha <full SHA> [--execute]
Validates retained staging evidence, clean candidate checkout and active staging
version/configuration. --execute then runs the production wipe check and existing
Worker deployment (readiness, tenant activation, migrations, upload). No SPA or CI
changes. Does not grant an activation override. Plan performs reads only.`,
  defaultDeps: io => ({
    io, read: path => readFile(path, "utf8"), provenance: captureProvenance,
    wipe: sha => deployWipeCheckCommand.run(["--release-sha", sha], deployWipeCheckCommand.defaultDeps(io)),
    // Same production connection string the wipe check reads; the deploy
    // applies pending migrations through it before the upload.
    deploy: sha => deployWorkerCommand.run(["--env", "production", "--release-sha", sha, "--execute", "--database-url-env", "PRODUCTION_DATABASE_URL"], deployWorkerCommand.defaultDeps(io)),
  }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({ args: argv, options: { check: { type: "string" }, evidence: { type: "string" }, "release-sha": { type: "string" }, execute: { type: "boolean", default: false } } }));
    } catch { throw new UsageError("invalid release arguments"); }
    if (values.check !== "token-revocation" || !values.evidence || !ShaSchema.safeParse(values["release-sha"]).success) throw new UsageError("require --check token-revocation, --evidence and full --release-sha");
    const sha = values["release-sha"]!;
    try {
      const report: unknown = JSON.parse(await deps.read(values.evidence));
      validateReleaseEvidence(report, await deps.provenance(sha), sha);
    } catch {
      deps.io.stderr("Release blocked: evidence missing, unreadable, failed, incomplete, or candidate/staging provenance mismatched. Production effects were not invoked.");
      return 1;
    }
    if (!values.execute) {
      deps.io.stdout("[PLAN] Evidence valid; execute would run production wipe check, activation/readiness checks, migrations and Worker upload.");
      return 0;
    }
    const wipeCode = await deps.wipe(sha);
    if (wipeCode !== 0) return wipeCode;
    return deps.deploy(sha);
  },
};
