import { accountWipeCommand } from "./commands/account-wipe";
import { accountResidueScanCommand } from "./commands/account-residue-scan";
import { accountAuditBareVectorsCommand } from "./commands/account-audit-bare-vectors";
// The single typed registry behind `npm run ops`. Root, group, and command
// help all render from these definitions, so a command that is not registered
// here does not exist as far as the operator interface is concerned. New
// commands (including the future system-policy command) register by adding
// their CommandDefinition to `commands` and, if needed, a new group.

import type { AnyCommand, CommandGroup } from "./contract";
import { accountSweepWipePrefixCommand } from "./commands/account-sweep-wipe-prefix";
import { corpusAuditCommand } from "./commands/corpus-audit";
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
import { corpusBackfillSimilarityCommand } from "./commands/corpus-backfill-similarity";
import { corpusRefreshNeighboursCommand } from "./commands/corpus-refresh-neighbours";
import { corpusRefreshConnectionsCommand } from "./commands/corpus-refresh-connections";
import { corpusRefreshTensionsCommand } from "./commands/corpus-refresh-tensions";
import { corpusBackfillVectorsCommand } from "./commands/corpus-backfill-vectors";
import { corpusDeleteOrphansCommand } from "./commands/corpus-delete-orphans";
import { corpusDropCommand } from "./commands/corpus-drop";
import { corpusIngestCommand } from "./commands/corpus-ingest";
import { corpusMigrateFounderCommand } from "./commands/corpus-migrate-founder";
import { corpusNormalizeTagsCommand } from "./commands/corpus-normalize-tags";
import { corpusPurgeConnectionsCommand } from "./commands/corpus-purge-connections";
import { corpusRebuildListCommand } from "./commands/corpus-rebuild-list";
import { corpusSeedVectorLedgerCommand } from "./commands/corpus-seed-vector-ledger";
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
    { name: "corpus", summary: "Corpus maintenance and repair" },
    { name: "reading", summary: "Single-reading operations against the reading API" },
    { name: "import", summary: "Imports into the reading API" },
    { name: "reading-list", summary: "Reading-list JSON export triage and submission" },
    { name: "deploy", summary: "Worker and Pages deployment" },
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
    corpusAuditCommand,
    corpusRecoverCommand,
    corpusIngestCommand,
    corpusDropCommand,
    corpusSweepCommand,
    corpusDeleteOrphansCommand,
    corpusBackfillSimilarityCommand,
    corpusRefreshNeighboursCommand,
    corpusRefreshConnectionsCommand,
    corpusRefreshTensionsCommand,
    corpusBackfillVectorsCommand,
    corpusMigrateFounderCommand,
    corpusNormalizeTagsCommand,
    corpusPurgeConnectionsCommand,
    corpusRebuildListCommand,
    corpusSeedVectorLedgerCommand,
    readingSubmitCommand,
    importMarkdownCommand,
    importBookmarksCommand,
    importRedditCommand,
    importYoutubeCommand,
    readingListCheckCommand,
    readingListProcessCommand,
    deployWorkerCommand,
    deployWipeCheckCommand,
    deployWebCommand,
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
    accountAuditBareVectorsCommand,
  ],
};
