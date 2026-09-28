// Provider error bodies become durable reading errors, API responses and log
// lines. OpenAI's 401 echoes a masked piece of the key it rejected
// ("Incorrect API key provided: sk-proj-****wxyz"), so every key-shaped token
// is replaced before the text is kept anywhere. The word boundary keeps words
// like "task-list" intact; `*` covers the provider's own masking.
const PROVIDER_KEY_IN_TEXT = /\bsk-[A-Za-z0-9_*-]+/g;

export function redactProviderKeys(text: string): string {
  return text.replace(PROVIDER_KEY_IN_TEXT, "[redacted key]");
}
