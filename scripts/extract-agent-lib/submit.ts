// Failed rows re-enter the pipeline through POST /api/readings/import-markdown:
// the Worker reprocesses a failed owner in place and no-ops (200, existing
// manifest) for ready/pending owners, so this path needs zero Worker changes
// and a lost race with the realtime writer is harmless.

import { importMarkdown, type ApiDeps, type ApiResult } from "../corpus-lib/api";

export interface SubmitBody {
  source_url: string;
  markdown: string;
  title?: string;
}

export type SubmitFn = (body: SubmitBody) => Promise<ApiResult>;

export function makeImportSubmitter(deps: ApiDeps & { email: boolean }): SubmitFn {
  return (body) => importMarkdown({ ...body, ...(deps.email ? { email: true } : {}) }, deps);
}
