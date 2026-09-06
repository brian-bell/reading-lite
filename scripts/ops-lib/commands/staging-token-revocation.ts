/** Bounded, unpaid token lifecycle drill using a recent operator session on a
 * controlled staging account. A fresh directory retains start + terminal files;
 * crashes leave a non-authorizing start file. Never persist HTTP bodies/secrets. */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { captureProvenance, EvidenceSchema, sameProvenance, ShaSchema, STAGING_ORIGIN, type Evidence, type Provenance } from "../../lib/release-evidence";
import { UsageError, type BaseDeps, type CommandDefinition } from "../contract";

interface Deps extends BaseDeps {
  fetch: typeof fetch;
  now(): string;
  newId(): string;
  session(): string;
  provenance(sha: string): Promise<Provenance>;
  reserve(path: string, start: unknown): Promise<void>;
  save(path: string, evidence: Evidence): Promise<void>;
}
export const stagingTokenRevocationCommand: CommandDefinition<Deps> = {
  group: "staging", name: "token-revocation", safety: "plan-first",
  summary: "Prove one staging token works, is revoked, and is rejected; retain evidence",
  helpText: `Usage: npm run ops -- staging token-revocation --tenant <usr_...> --release-sha <full SHA> --output <new-directory> [--execute]
Uses STAGING_SESSION_COOKIE from the environment (never a CLI argument). Requires
a recent session for a controlled staging account and a clean candidate checkout.
Staging must serve that commit tagged by deploy worker --release-sha. Fixed target:
${STAGING_ORIGIN}. Creates one read-only token with a 15-minute TTL;
creation can send security email to the controlled account. Revokes only the run's
token. Retains the session and revoked token record. No signup, paid work or wipes.
Evidence output must be outside the checkout; directories cannot be reused.
Plan does not read credentials, call staging, or write evidence.`,
  defaultDeps: io => ({
    io, fetch: globalThis.fetch, now: () => new Date().toISOString(), newId: randomUUID,
    session: () => {
      const cookie = process.env.STAGING_SESSION_COOKIE;
      if (!cookie || !/^__Host-session=[^;\s]+$/.test(cookie)) throw new Error("missing or invalid STAGING_SESSION_COOKIE");
      return cookie;
    },
    provenance: captureProvenance,
    reserve: async (path, start) => {
      const root = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"]);
      const destination = resolve(await realpath(dirname(resolve(path))), basename(resolve(path)));
      const fromRoot = relative(await realpath(root.stdout.trim()), destination);
      if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))) throw new Error("evidence directory must be outside the checkout");
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "start.json"), JSON.stringify(start, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    },
    save: async (path, evidence) => {
      await writeFile(join(path, "result.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    },
  }),
  async run(argv, deps) {
    let values;
    try {
      ({ values } = parseArgs({ args: argv, options: { tenant: { type: "string" }, "release-sha": { type: "string" }, output: { type: "string" }, execute: { type: "boolean", default: false } } }));
    } catch { throw new UsageError("invalid token drill arguments"); }
    if (!values.tenant || !/^usr_[a-zA-Z0-9_-]+$/.test(values.tenant) || !values.output || !ShaSchema.safeParse(values["release-sha"]).success) throw new UsageError("require --tenant, --release-sha and --output");
    if (!values.execute) {
      deps.io.stdout(`[PLAN] Verify staging provenance and tenant session; create one read token, prove access, revoke, prove rejection, confirm cleanup; retain evidence in ${values.output}. Token creation may send security email.`);
      return 0;
    }
    const runId = deps.newId();
    const report: Evidence = {
      schema_version: 1, check: "token-revocation", run_id: runId, origin: STAGING_ORIGIN,
      release_sha: values["release-sha"]!, tenant: values.tenant,
      started_at: deps.now(), finished_at: deps.now(), provenance: null, provenance_unchanged: false,
      checks: [], cleanup: "not-created", restoration: "no configuration changes; operator session retained; revoked token record retained",
      token_id: null, token_name: `release-drill-${runId}`, exit_code: 1, failure_stage: null,
    };
    await deps.reserve(values.output, { run_id: runId, check: report.check, release_sha: report.release_sha, tenant: report.tenant, started_at: report.started_at, token_name: report.token_name, state: "started", command: ["ops", "staging", "token-revocation", "--tenant", report.tenant, "--release-sha", report.release_sha, "--output", values.output, "--execute"] });
    let stage = "provenance";
    let cookie = "";
    let csrf = "";
    let creationAttempted = false;
    const request = async (step: string, path: string, expected: number, method = "GET", token?: string, body?: unknown): Promise<unknown> => {
      stage = step;
      const observation = { step, status: null as number | null, passed: false };
      report.checks.push(observation);
      const response = await deps.fetch(`${STAGING_ORIGIN}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: token ? { authorization: `Bearer ${token}` } : {
          cookie, origin: STAGING_ORIGIN, "x-csrf-token": csrf, "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      observation.status = response.status;
      if (response.status !== expected) throw new Error("unexpected HTTP status");
      // Refusal bodies are deliberately never retained or parsed.
      const result: unknown = expected === 401 ? null : await response.json();
      observation.passed = true;
      return result;
    };
    const sessionBody = z.object({ principal: z.literal("session"), tenant_id: z.literal(report.tenant), csrf_token: z.string().min(1) });
    try {
      report.provenance = await deps.provenance(report.release_sha);
      stage = "credentials";
      cookie = deps.session();
      const session = sessionBody.parse(await request("session", "/api/whoami", 200));
      csrf = session.csrf_token;
      creationAttempted = true;
      report.cleanup = "unresolved";
      const created = z.object({ id: z.string().regex(/^tok_[a-zA-Z0-9_-]+$/), token: z.string().min(1) }).parse(await request("create", "/api/auth/tokens", 201, "POST", undefined, {
        name: report.token_name, scopes: ["readings:read"], expires_at_ms: Date.parse(deps.now()) + 15 * 60_000,
      }));
      report.token_id = created.id;
      z.object({ principal: z.literal("api_token"), tenant_id: z.literal(report.tenant) }).parse(await request("baseline", "/api/whoami", 200, "GET", created.token));
      await request("revoke", `/api/auth/tokens/${encodeURIComponent(created.id)}`, 200, "DELETE");
      await request("rejected", "/api/whoami", 401, "GET", created.token);
      sessionBody.parse(await request("session_after", "/api/whoami", 200));
    } catch {
      report.failure_stage = stage;
      const last = report.checks.at(-1);
      if (last?.step === stage) last.passed = false;
    } finally {
      if (creationAttempted) {
        try {
          const list = async (step: string) => z.object({ tokens: z.array(z.object({
            id: z.string().regex(/^tok_[a-zA-Z0-9_-]+$/), name: z.string(), usable: z.boolean(), revoked_at_ms: z.number().nullable(),
          })) }).parse(await request(step, "/api/auth/tokens", 200)).tokens.filter(t => t.name === report.token_name);
          // Name recovery handles a delivered POST whose response was lost.
          const matches = await list("cleanup_list");
          if (matches.length !== 1 || (report.token_id && matches[0]!.id !== report.token_id)) throw new Error("ambiguous cleanup selector");
          const token = matches[0]!;
          report.token_id = token.id;
          if (token.revoked_at_ms === null) await request("cleanup_revoke", `/api/auth/tokens/${encodeURIComponent(token.id)}`, 200, "DELETE");
          const confirmed = await list("cleanup_confirm");
          if (confirmed.length !== 1 || confirmed[0]!.id !== token.id || confirmed[0]!.usable || confirmed[0]!.revoked_at_ms === null) throw new Error("revocation unconfirmed");
          report.cleanup = "revoked";
        } catch {
          report.cleanup = "unresolved";
          report.failure_stage ??= "cleanup";
        }
      }
      try {
        stage = "provenance_after";
        const after = await deps.provenance(report.release_sha);
        report.provenance_unchanged = report.provenance !== null && sameProvenance(report.provenance, after);
        if (!report.provenance_unchanged) report.failure_stage ??= stage;
      } catch { report.failure_stage ??= "provenance_after"; }
      report.finished_at = deps.now();
      report.exit_code = report.failure_stage === null && report.cleanup === "revoked" ? 0 : 1;
      await deps.save(values.output, EvidenceSchema.parse(report));
    }
    deps.io.stdout(`Token drill exit ${report.exit_code}; cleanup=${report.cleanup}; evidence=${join(values.output, "result.json")}`);
    return report.exit_code;
  },
};
