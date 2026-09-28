import { describe, expect, it } from "vitest";
import { providerErrorText, redactProviderKeys } from "../../../src/modules/provider-error-text";

describe("providerErrorText", () => {
  it.each([
    ["the provider's JSON error.message", '{"error":{"message":"model not found"}}', undefined, "model not found"],
    ["a raw body when error.message is not a string", '{"error":{"message":["upstream"]}}', undefined, '{"error":{"message":["upstream"]}}'],
    ["a raw body that is not JSON", "<html>502 Bad Gateway</html>", undefined, "<html>502 Bad Gateway</html>"],
    ["a JSON null body", "null", undefined, "null"],
    ["the fallback for an empty body", "", undefined, "OpenAI returned 502"],
    ["a raw body bounded by maxRaw", "x".repeat(20), 5, "xxxxx"],
    [
      "a redacted key",
      '{"error":{"message":"Incorrect API key provided: sk-proj-****wxyz."}}',
      undefined,
      "Incorrect API key provided: [redacted key].",
    ],
  ])("returns %s", (_case, body, maxRaw, expected) => {
    expect(providerErrorText(body, "OpenAI returned 502", maxRaw)).toBe(expected);
  });
});

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
    [
      "a dot-masked echo, keeping the sentence's period",
      "Incorrect API key provided: sk-...abcd.",
      "Incorrect API key provided: [redacted key].",
    ],
    ["a dot-masked project key", "key sk-proj-ab12...wxyz rejected", "key [redacted key] rejected"],
    ["an ellipsis-masked key", "key sk-…abcd rejected", "key [redacted key] rejected"],
    [
      "a masked key run into the next sentence",
      "provided: sk-proj-****abcd.Please check",
      "provided: [redacted key].Please check",
    ],
    [
      "a full key run into the next sentence",
      "provided: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345.You can",
      "provided: [redacted key].You can",
    ],
    ["a truncated key", "Incorrect API key provided: sk-proj-abcd.", "Incorrect API key provided: [redacted key]."],
    ["a service-account key", "key sk-svcacct-AbC_123-xyz rejected", "key [redacted key] rejected"],
    ["an unmasked Anthropic key", "x-api-key sk-ant-api03-AbC_dEf-123 is invalid", "x-api-key [redacted key] is invalid"],
    [
      "a key in a URL query",
      "POST https://api.example.com/v1?api_key=sk-proj-ABCDEF failed",
      "POST https://api.example.com/v1?api_key=[redacted key] failed",
    ],
    [
      "a key run on after a URL",
      '{"detail":"see https://platform.openai.com/docs","key":"sk-proj-****wxyz"}',
      '{"detail":"see https://platform.openai.com/docs","key":"[redacted key]"}',
    ],
    [
      "an sk- hostname, failing safe",
      "bad response status 404: https://www.sk-hynix.com/news",
      "bad response status 404: https://www.[redacted key].com/news",
    ],
    ["a key after a URL-encoded space", "Bearer%20sk-proj-ABCDEF", "Bearer%20[redacted key]"],
    ["a key after a URL-encoded =", "api_key%3Dsk-proj-ABCDEF", "api_key%3D[redacted key]"],
    ["a key after a literal \\n escape", String.raw`provided:\nsk-proj-ABCDEF`, String.raw`provided:\n[redacted key]`],
    ["a bullet-masked key", "key sk-proj-••••wxyz rejected", "key [redacted key] rejected"],
    ["a two-dot mask", "key sk-ab..wxyz rejected", "key [redacted key] rejected"],
    ["two keys", "sk-a1 then sk-b2", "[redacted key] then [redacted key]"],
  ])("redacts %s", (_case, raw, redacted) => {
    expect(redactProviderKeys(raw)).toBe(redacted);
  });

  it.each([
    ["words that contain sk-", "task-list and risk-free desk-top, ask-me"],
    ["a message without a key", "Rate limit reached for gpt-5.4 in organization org-abc"],
    ["an uppercase SK- word", "Accept-Language SK-sk rejected"],
  ])("leaves %s unchanged", (_case, text) => {
    expect(redactProviderKeys(text)).toBe(text);
  });
});
