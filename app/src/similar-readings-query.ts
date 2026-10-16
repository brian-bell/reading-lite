import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { postCapture } from "./api/capture";
import { apiFetch } from "./api/client";
import { NetworkError } from "./api/errors";
import { EXPECTED_TENANT_HEADER } from "./api/readings";
import { whoamiQueryKey, type Identity } from "./identity";
import { expectedLayoutOf, type Reading } from "./reading";
import {
  meaningOutcomeFromResponse,
  similarReadingsFromResponse,
  type MeaningOutcome,
  type MeaningQuestion,
  type MeaningView,
  type SimilarReading,
  type SimilarReadingsResult,
} from "./similar-readings";

// The only module that calls either endpoint, both browser-only: neither is
// part of a server render or a loader's prefetch.
//
// A question costs the reader money, so its query options stay private: no
// other module can observe it with `enabled` on, prefetch it, or put it under
// ["library"], where every write's invalidation would ask again. Only Find's
// submit spends (runMeaningSearch). The answer stays cached for the page
// session, so Back to the entry that asked shows it again for free.

function meaningSearchOptions(
  queryClient: QueryClient,
  identity: Identity | null | undefined,
  question: MeaningQuestion | undefined,
) {
  const expectedTenant = expectedLayoutOf(identity);
  return queryOptions({
    queryKey: ["meaning-search", question ?? ""] as const,
    // No AbortSignal: an answer already paid for lands in the cache even when
    // the reader has opened a reading meanwhile.
    queryFn: (): Promise<MeaningOutcome> =>
      postCapture(queryClient, "/api/readings/search", { query: question }, expectedTenant, meaningOutcomeFromResponse),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

/**
 * Asks once. Every submit asks again, and a submit while the same question is
 * in flight shares that request, so a double press spends once. Settles
 * without throwing; the outcome is read through useMeaningResult.
 */
export async function runMeaningSearch(
  queryClient: QueryClient,
  identity: Identity | null | undefined,
  question: MeaningQuestion,
): Promise<void> {
  await queryClient
    .fetchQuery({ ...meaningSearchOptions(queryClient, identity, question), staleTime: 0 })
    .catch(() => undefined);
}

const IDLE: MeaningView = { state: "idle" };
const RUNNING: MeaningView = { state: "running" };
const OFFLINE: MeaningView = { state: "offline" };

/** Observes a question's answer. Mounting, Back, focus, and reconnect never fetch. */
export function useMeaningResult(question: MeaningQuestion | undefined): MeaningView {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data, error, fetchStatus } = useQuery(meaningSearchOptions(queryClient, identity, question));
  if (question === undefined) return IDLE;
  if (fetchStatus === "fetching") return RUNNING;
  if (fetchStatus === "paused") return OFFLINE;
  if (error) return error instanceof NetworkError && error.offline ? OFFLINE : { state: "failed", message: error.message };
  if (data === undefined) return IDLE;
  return { state: "done", outcome: data };
}

const NONE: readonly SimilarReading[] = Object.freeze([]);

/**
 * More like this, on the reading page only: observed after hydration like the
 * thread strip, never prefetched. Under ["library"] because it is free, so a
 * finished attempt's invalidation refreshes it. Nothing while it loads, on any
 * error, and when refused, so the group takes no space then.
 */
export function useMoreLikeThis(reading: Reading): readonly SimilarReading[] {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const { data, status } = useQuery({
    queryKey: ["library", "similar", reading.id],
    queryFn: ({ signal }) => fetchSimilarReadings(queryClient, expectedTenant, reading.id, signal),
    enabled: identity != null && reading.status === "ready",
    staleTime: Infinity,
    retry: false,
  });
  return status === "success" && data.state === "ready" ? data.value : NONE;
}

async function fetchSimilarReadings(
  queryClient: QueryClient,
  expectedTenant: string | undefined,
  id: string,
  signal: AbortSignal,
): Promise<SimilarReadingsResult> {
  const response = await apiFetch(queryClient, `/api/readings/${encodeURIComponent(id)}/similar`, {
    headers: expectedTenant === undefined ? {} : { [EXPECTED_TENANT_HEADER]: expectedTenant },
    signal,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON: similarReadingsFromResponse decides from the status.
  }
  return similarReadingsFromResponse(response.status, body);
}
