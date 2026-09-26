import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NetworkError, isUnauthorized } from "../api/errors";
import { reprocessReading } from "../api/reprocess";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf, readingQueryKey } from "../reading";
import type { ReprocessOutcome } from "../reprocess";

// Retry on a failed reading and Reprocess on a ready one (#410): one request,
// POST /api/readings/:id/reprocess, sent only when the reader asks. The page
// that uses this is keyed on the reading id (ReadingPage.tsx), so an answer or
// a request in flight belongs to one reading and is gone with it.
//
// - Never twice at once. The backend checks for a running attempt and then
//   writes the manifest without a condition (src/intake/activation.ts), so two
//   requests in flight together would both start a paid run. `sendingRef`
//   refuses a second send until the first has settled.
// - Never on its own. `retry: 0`, and `networkMode: "always"`: a save made
//   offline is held paused and sent when the network returns (SavePage.tsx),
//   but a paid run sent minutes later, perhaps after the reader has left,
//   would be the automatic repeat the acceptance matrix rules out. Offline
//   fails at once and the reader asks again.
// - The reading is refreshed after an answer that changed something — a
//   started attempt, one already running, a reading that is gone — and the
//   library only after a started one, whose rows it changed. Both in the
//   mutation's own `onSettled`, which runs even when the reader has left the
//   page mid-request. The reading query never goes stale on its own
//   (reading-query.ts), so without it they would come back to the manifest
//   from before the request and no watch. The refetch is also what starts the
//   watch: it shows the new attempt, whose id is the watch's key (contract
//   check 9), and after a 409 it shows the attempt that was already running.
//   A refusal changed nothing, and its notice is not held back behind a read.
//   A request that failed without an answer may still have reached the
//   backend, so it is read as a started one would be.

/** What stays on the page after an answer that did not start an attempt, until the next send (or, for already-processing, until that attempt ends). */
export type ReprocessNotice =
  | Exclude<ReprocessOutcome, { kind: "started" | "not-found" }>
  | { kind: "offline" }
  | { kind: "server-error"; message: string };

export interface Reprocess {
  send: () => void;
  /** Whether a request is in flight; its controls are `aria-disabled`. */
  sending: boolean;
  /** The last answer's notice: a new object for each answer, so the same words said twice are two events. */
  notice: ReprocessNotice | null;
}

/** The answers after which the reading on screen is no longer what the backend holds. */
const CHANGED_THE_READING: ReadonlySet<ReprocessOutcome["kind"]> = new Set(["started", "already-processing", "not-found"]);

export function useReprocess(id: string, processing: boolean): Reprocess {
  const queryClient = useQueryClient();
  const sendingRef = useRef(false);
  const [notice, setNotice] = useState<ReprocessNotice | null>(null);

  // "Already processing" is about the attempt the 409 found. Once this page
  // has seen that attempt running and then seen the reading no longer
  // processing, it has ended and the status card says how; the notice would
  // contradict it. Only an observed end clears it: a refetch that failed
  // leaves the reading from before the request cached, which proves nothing.
  const sawProcessing = useRef(false);
  useEffect(() => {
    if (notice?.kind !== "already-processing") {
      sawProcessing.current = false;
      return;
    }
    if (processing) sawProcessing.current = true;
    else if (sawProcessing.current) setNotice(null);
  }, [processing, notice]);

  const mutation = useMutation({
    mutationFn: () =>
      reprocessReading(queryClient, id, expectedLayoutOf(queryClient.getQueryData<Identity | null>(whoamiQueryKey))),
    networkMode: "always",
    retry: 0,
    onSettled: (outcome) => {
      const kind = outcome?.kind ?? "started";
      return Promise.all([
        CHANGED_THE_READING.has(kind) ? queryClient.invalidateQueries({ queryKey: readingQueryKey(id) }) : undefined,
        kind === "started" ? queryClient.invalidateQueries({ queryKey: ["library"] }) : undefined,
      ]);
    },
  });

  function send() {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setNotice(null);
    mutation
      .mutateAsync()
      .then(
        (outcome) => {
          // A started attempt shows itself through the refetch; a 404 renders
          // the not-found state the same way.
          if (outcome.kind !== "started" && outcome.kind !== "not-found") setNotice(outcome);
        },
        (error: unknown) => {
          // A 401 is the mutation cache's (auth/session.ts): the shell
          // replaces the page, and nothing here needs saying.
          if (!isUnauthorized(error)) setNotice(noticeOfError(error));
        },
      )
      .finally(() => {
        sendingRef.current = false;
      });
  }

  return { send, sending: mutation.isPending, notice };
}

function noticeOfError(error: unknown): ReprocessNotice {
  if (error instanceof NetworkError && error.offline) return { kind: "offline" };
  return { kind: "server-error", message: error instanceof Error ? error.message : String(error) };
}
