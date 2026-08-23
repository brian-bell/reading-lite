// Failed rows re-enter the pipeline through POST /api/readings/import-markdown:
// the Worker reprocesses a failed owner in place and no-ops (200, existing
// manifest) for ready/pending owners, so this path needs zero Worker changes
// and a lost race with the realtime writer is harmless.

import { classifyOutcome, type ReadingApi } from "../lib/reading-api";

export interface SubmitBody {
  source_url: string;
  markdown: string;
  title?: string;
}

// The extract-agent's three-bucket view of a submit. An initializing owner
// counts as existing (someone owns the URL and work is in flight).
export interface ApiResult {
  outcome: "new" | "existing" | "error";
  id?: string;
  error?: string;
}

export type SubmitFn = (body: SubmitBody) => Promise<ApiResult>;

export function makeImportSubmitter(deps: {
  api: Pick<ReadingApi, "importMarkdown">;
  email: boolean;
}): SubmitFn {
  return async (body) => {
    const out = await deps.api.importMarkdown({
      ...body,
      ...(deps.email ? { email: true } : {}),
    });
    const { classification, id, error } = classifyOutcome(out);
    return {
      outcome: classification,
      ...(id === undefined ? {} : { id }),
      ...(error === undefined ? {} : { error }),
    };
  };
}
