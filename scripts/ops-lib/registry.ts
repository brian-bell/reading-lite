// The single typed registry behind `npm run ops`. Root, group, and command
// help all render from these definitions, so a command that is not registered
// here does not exist as far as the operator interface is concerned. New
// commands (including the future system-policy command) register by adding
// their CommandDefinition to `commands` and, if needed, a new group.

import type { AnyCommand, CommandGroup } from "./contract";
import { corpusAuditCommand } from "./commands/corpus-audit";

export interface Registry {
  groups: CommandGroup[];
  commands: AnyCommand[];
}

export const defaultRegistry: Registry = {
  groups: [
    { name: "corpus", summary: "Corpus maintenance and repair" },
  ],
  commands: [
    corpusAuditCommand,
  ],
};
