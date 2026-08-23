// The single typed registry behind `npm run ops`. Root, group, and command
// help all render from these definitions, so a command that is not registered
// here does not exist as far as the operator interface is concerned. New
// commands (including the future system-policy command) register by adding
// their CommandDefinition to `commands` and, if needed, a new group.

import type { AnyCommand, CommandGroup } from "./contract";
import { corpusAuditCommand } from "./commands/corpus-audit";
import { corpusBackfillSimilarityCommand } from "./commands/corpus-backfill-similarity";
import { corpusBackfillVectorsCommand } from "./commands/corpus-backfill-vectors";
import { corpusDeleteOrphansCommand } from "./commands/corpus-delete-orphans";
import { corpusDropCommand } from "./commands/corpus-drop";
import { corpusIngestCommand } from "./commands/corpus-ingest";
import { corpusNormalizeTagsCommand } from "./commands/corpus-normalize-tags";
import { corpusRebuildListCommand } from "./commands/corpus-rebuild-list";
import { corpusRecoverCommand } from "./commands/corpus-recover";
import { corpusSweepCommand } from "./commands/corpus-sweep";
import { importMarkdownCommand } from "./commands/import-markdown";
import { readingSubmitCommand } from "./commands/reading-submit";

export interface Registry {
  groups: CommandGroup[];
  commands: AnyCommand[];
}

export const defaultRegistry: Registry = {
  groups: [
    { name: "corpus", summary: "Corpus maintenance and repair" },
    { name: "reading", summary: "Single-reading operations against the reading API" },
    { name: "import", summary: "Bulk imports into the reading API" },
  ],
  commands: [
    corpusAuditCommand,
    corpusRecoverCommand,
    corpusIngestCommand,
    corpusDropCommand,
    corpusSweepCommand,
    corpusDeleteOrphansCommand,
    corpusBackfillSimilarityCommand,
    corpusBackfillVectorsCommand,
    corpusNormalizeTagsCommand,
    corpusRebuildListCommand,
    readingSubmitCommand,
    importMarkdownCommand,
  ],
};
