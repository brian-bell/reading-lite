import { describe, expect, it } from "vitest";
import { redactProviderKeys } from "../../../src/modules/provider-error-text";

describe("redactProviderKeys", () => {
  it.each([
    [
      "an OpenAI project key echo",
      "Incorrect API key provided: sk-proj-****wxyz. You can find your API key at https://platform.openai.com/account/api-keys.",
      "Incorrect API key provided: [redacted key]. You can find your API key at https://platform.openai.com/account/api-keys.",
    ],
    [
      "a legacy key with a long mask",
      "Incorrect API key provided: sk-abc1************************************wxyz.",
      "Incorrect API key provided: [redacted key].",
    ],
    ["a service-account key", "key sk-svcacct-AbC_123-xyz rejected", "key [redacted key] rejected"],
    ["an unmasked Anthropic key", "x-api-key sk-ant-api03-AbC_dEf-123 is invalid", "x-api-key [redacted key] is invalid"],
    ["two keys", "sk-a1 then sk-b2", "[redacted key] then [redacted key]"],
  ])("redacts %s", (_case, raw, redacted) => {
    expect(redactProviderKeys(raw)).toBe(redacted);
  });

  it.each([
    ["words that contain sk-", "task-list and risk-free desk-top"],
    ["a message without a key", "Rate limit reached for gpt-5.4 in organization org-abc"],
  ])("leaves %s unchanged", (_case, text) => {
    expect(redactProviderKeys(text)).toBe(text);
  });
});
