import { z } from "zod";

// A redirect would carry the bearer token off this host.
const MODELS_URL = "https://api.openai.com/v1/models";
const MODEL_LIST_TIMEOUT_MS = 10_000;

const ModelsPageSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

export type ProviderKeyRejection = "invalid_key" | "model_access" | "provider_unavailable";

export type ProviderKeyCheck =
  | { ok: true }
  | { ok: false; code: ProviderKeyRejection };

/** A non-200 body is discarded unread. OpenAI's 401 text echoes key material. */
export async function checkOpenAIProviderKey(input: {
  fetch: typeof fetch;
  apiKey: string;
  summarizationModel: string;
  embeddingModel: string;
  timeoutMs?: number;
}): Promise<ProviderKeyCheck> {
  const signal = AbortSignal.timeout(input.timeoutMs ?? MODEL_LIST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await input.fetch(MODELS_URL, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal,
    });
  } catch {
    return { ok: false, code: "provider_unavailable" };
  }

  if (response.status === 401) {
    await discard(response);
    return { ok: false, code: "invalid_key" };
  }
  if (response.status === 403) {
    await discard(response);
    return { ok: false, code: "model_access" };
  }
  if (response.status !== 200) {
    await discard(response);
    return { ok: false, code: "provider_unavailable" };
  }

  const json = await readJson(response, signal);
  const parsed = ModelsPageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "provider_unavailable" };
  const ids = new Set(parsed.data.data.map((model) => model.id));
  if (!ids.has(input.summarizationModel) || !ids.has(input.embeddingModel)) {
    return { ok: false, code: "model_access" };
  }
  return { ok: true };
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    await discard(response);
    return null;
  }
  return new Promise((resolve) => {
    const finish = (value: unknown) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      void discard(response);
      finish(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void response.json().then(finish, () => finish(null));
  });
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
