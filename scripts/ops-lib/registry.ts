// The single typed registry behind `npm run ops`. Root, group, and command
// help all render from these definitions, so a command that is not registered
// here does not exist as far as the operator interface is concerned. New
// commands (including the future system-policy command) register by adding
// their CommandDefinition to `commands` and, if needed, a new group.

import type { AnyCommand, CommandGroup } from "./contract";
import { corpusAuditCommand } from "./commands/corpus-audit";
import { corpusRecoverCommand } from "./commands/corpus-recover";
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
    readingSubmitCommand,
    importMarkdownCommand,
  ],
};
