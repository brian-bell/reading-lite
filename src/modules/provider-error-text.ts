// Provider error bodies become durable reading errors, API responses and log
// lines. OpenAI's 401 echoes a masked piece of the key it rejected
// ("Incorrect API key provided: sk-proj-****wxyz"), so every key-shaped token
// is replaced before the text is kept anywhere. A preceding letter means a
// word like "task-list", not a key, unless that letter ends a %XX escape or
// a backslash escape like \n (api_key%3Dsk-…, a raw "\nsk-…" body); a digit
// or `_` never does.
// `*`, `•`, `…` and a run of dots are the provider's own masking
// (sk-...abcd); a single dot ends the token, so a sentence's period and
// whatever follows it survive. This fails safe: an sk- segment in a URL
// (sk-hynix.com in a fetch error) is redacted too, since a key in a URL or
// run on after one must never be kept.
const PROVIDER_KEY_IN_TEXT =
  /(?<!(?<!%[0-9A-Fa-f]|\\)[A-Za-z])sk-(?:[A-Za-z0-9_*•…-]|\.{2,})+/g;

export function redactProviderKeys(text: string): string {
  return text.replace(PROVIDER_KEY_IN_TEXT, "[redacted key]");
}

// The message for a failed provider response: the provider's own JSON
// error.message when it sent a string one, else the raw body (cut to maxRaw
// when given), else the fallback. A gateway can send any shape, so nothing
// about the body is trusted, and the result is always key-redacted.
export function providerErrorText(body: string, fallback: string, maxRaw?: number): string {
  let message = (maxRaw === undefined ? body : body.slice(0, maxRaw)) || fallback;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } } | null;
    const provided = parsed?.error?.message;
    if (typeof provided === "string" && provided) message = provided;
  } catch {
    // Not JSON: keep the raw body.
  }
  return redactProviderKeys(message);
}
