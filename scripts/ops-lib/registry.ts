import { stagingTokenRevocationCommand } from "./commands/staging-token-revocation";
import { deployReleaseCommand } from "./commands/deploy-release";
import { stagingPrepareContextCommand } from "./commands/staging-prepare-context";
import { systemLeaseClearCommand } from "./commands/system-lease-clear";
import { systemPolicyCommand } from "./commands/system-policy";
import { systemStatusCommand } from "./commands/system-status";
import { accountWipeCommand } from "./commands/account-wipe";
import { accountResidueScanCommand } from "./commands/account-residue-scan";
// The single typed registry behind `npm run ops`. Root, group, and command
// help all render from these definitions, so a command that is not registered
// here does not exist as far as the operator interface is concerned. New
// commands (including the future system-policy command) register by adding
// their CommandDefinition to `commands` and, if needed, a new group.

import type { AnyCommand, CommandGroup } from "./contract";
import { accountSweepWipePrefixCommand } from "./commands/account-sweep-wipe-prefix";
import { corpusAuditCommand } from "./commands/corpus-audit";
import { dbMigrateCommand } from "./commands/db-migrate";
import { deployWipeCheckCommand } from "./commands/deploy-wipe-check";
import { deployWebCommand } from "./commands/deploy-web";
import { deployWorkerCommand } from "./commands/deploy-worker";
import { evalSummarizerCommand } from "./commands/eval-summarizer";
import { extractAgentCommand } from "./commands/extract-agent";
import { extractProbeCommand } from "./commands/extract-probe";
import { founderBootstrapCommand } from "./commands/founder-bootstrap";
import { stagingSetupCommand } from "./commands/staging-setup";
import { stagingSmokeCommand } from "./commands/staging-smoke";
import { stagingTeardownCommand } from "./commands/staging-teardown";
import { corpusRefreshNeighboursCommand } from "./commands/corpus-refresh-neighbours";
import { corpusRefreshConnectionsCommand } from "./commands/corpus-refresh-connections";
import { corpusRefreshTensionsCommand } from "./commands/corpus-refresh-tensions";
import { corpusDropCommand } from "./commands/corpus-drop";
import { corpusIngestCommand } from "./commands/corpus-ingest";
import { corpusPurgeConnectionsCommand } from "./commands/corpus-purge-connections";
import { corpusRecoverCommand } from "./commands/corpus-recover";
import { corpusSweepCommand } from "./commands/corpus-sweep";
import { importBookmarksCommand } from "./commands/import-bookmarks";
import { importMarkdownCommand } from "./commands/import-markdown";
import { importRedditCommand } from "./commands/import-reddit";
import { importYoutubeCommand } from "./commands/import-youtube";
import { readingListCheckCommand } from "./commands/reading-list-check";
import { readingListProcessCommand } from "./commands/reading-list-process";
import { readingSubmitCommand } from "./commands/reading-submit";

export interface Registry {
  groups: CommandGroup[];
  commands: AnyCommand[];
}

export const defaultRegistry: Registry = {
  groups: [
    { name: "system", summary: "Paid-work policy and accounting" },
    { name: "corpus", summary: "Corpus maintenance and repair" },
    { name: "reading", summary: "Single-reading operations against the reading API" },
    { name: "import", summary: "Imports into the reading API" },
    { name: "reading-list", summary: "Reading-list JSON export triage and submission" },
    { name: "deploy", summary: "Worker and Pages deployment" },
    { name: "db", summary: "PostgreSQL schema migrations" },
    { name: "staging", summary: "Staging environment lifecycle and smoke checks" },
    { name: "founder", summary: "Founder control-plane bootstrap" },
    { name: "extract", summary: "Local extraction agent and probe" },
    { name: "eval", summary: "Summarizer quality evaluation" },
    // Account-deletion housekeeping: operator work on the wipe pipeline's own
    // bucket-root state, which is neither corpus content nor a deployment. The
    // residue-scan and wipe operator commands of later #195 slices land here.
    { name: "account", summary: "Account-deletion housekeeping and wipe residue" },
  ],
  commands: [
    systemPolicyCommand,
    systemStatusCommand,
    systemLeaseClearCommand,
    corpusAuditCommand,
    corpusRecoverCommand,
    corpusIngestCommand,
    corpusDropCommand,
    corpusSweepCommand,
    corpusRefreshNeighboursCommand,
    corpusRefreshConnectionsCommand,
    corpusRefreshTensionsCommand,
    corpusPurgeConnectionsCommand,
    readingSubmitCommand,
    importMarkdownCommand,
    importBookmarksCommand,
    importRedditCommand,
    importYoutubeCommand,
    readingListCheckCommand,
    readingListProcessCommand,
    deployReleaseCommand,
    stagingTokenRevocationCommand,
    deployWorkerCommand,
    dbMigrateCommand,
    deployWipeCheckCommand,
    deployWebCommand,
    stagingPrepareContextCommand,
    stagingSetupCommand,
    stagingTeardownCommand,
    stagingSmokeCommand,
    founderBootstrapCommand,
    extractAgentCommand,
    extractProbeCommand,
    evalSummarizerCommand,
    accountSweepWipePrefixCommand,
    accountWipeCommand,
    accountResidueScanCommand,
  ],
};
