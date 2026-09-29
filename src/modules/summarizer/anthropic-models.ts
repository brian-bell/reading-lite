import type { AnthropicReasoningEffort } from "./types";

// Claude API id for Claude Sonnet 5.5. Confirmed on the model page:
// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
export const CLAUDE_SONNET_5_5 = "claude-sonnet-5-5";

const ANTHROPIC_EFFORT_LOW_MEDIUM_HIGH = [
  "low",
  "medium",
  "high",
] as const satisfies readonly AnthropicReasoningEffort[];
const ANTHROPIC_EFFORT_WITH_MAX = [
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly AnthropicReasoningEffort[];
const ANTHROPIC_EFFORT_ALL = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AnthropicReasoningEffort[];

// Intersection of official effort availability and the thinking setting
// anthropicMessagesControls sends.
// https://platform.claude.com/docs/en/build-with-claude/effort
// https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
// Sonnet 5.5 rejects thinking disabled. between_tools is its lowest setting
// and 400s at xhigh|max. Sonnet 5 and the Opus rows below send thinking
// disabled. Fable 5, Mythos 5, and Mythos Preview reject disabled thinking
// (omitted). Opus 5 accepts disabled thinking only at high or below.
// Unknown models fail closed.
export const ANTHROPIC_EFFORTS_BY_MODEL: Record<
  string,
  readonly AnthropicReasoningEffort[]
> = {
  [CLAUDE_SONNET_5_5]: ANTHROPIC_EFFORT_LOW_MEDIUM_HIGH,
  "claude-sonnet-5": ANTHROPIC_EFFORT_ALL,
  "claude-opus-5": ANTHROPIC_EFFORT_LOW_MEDIUM_HIGH,
  "claude-opus-4-8": ANTHROPIC_EFFORT_ALL,
  "claude-opus-4-7": ANTHROPIC_EFFORT_ALL,
  "claude-sonnet-4-6": ANTHROPIC_EFFORT_WITH_MAX,
  "claude-opus-4-6": ANTHROPIC_EFFORT_WITH_MAX,
  "claude-opus-4-5-20251101": ANTHROPIC_EFFORT_LOW_MEDIUM_HIGH,
};

export interface AnthropicMessagesControls {
  thinking: { type: "disabled" } | { type: "between_tools" };
  // Sonnet 5.5 rejects tool_choice "any" and "tool". Earlier models keep
  // forced tool use so a named tool or any-tool choice still binds.
  forceTool: boolean;
}

export function anthropicMessagesControls(model: string): AnthropicMessagesControls {
  if (model === CLAUDE_SONNET_5_5) {
    return { thinking: { type: "between_tools" }, forceTool: false };
  }
  return { thinking: { type: "disabled" }, forceTool: true };
}
