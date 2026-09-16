import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
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
// - The reading and the library are refreshed after every answer, in the
//   mutation's own `onSettled`, which runs even when the reader has left the
//   page mid-request. The reading query never goes stale on its own
//   (reading-query.ts), so without it they would come back to the manifest
//   from before the request and no watch. The refetch is also what starts the
//   watch: it shows the new attempt, whose id is the watch's key (contract
//   check 9), and after a 409 it shows the attempt that was already running.
//   It is also what shows a reading the reader has lost access to: a 403 or
//   412 on the write is a notice, and the reading's own read decides whether
//   the page is still theirs.

/** What stays on the page after an answer that did not start an attempt. */
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

export function useReprocess(id: string): Reprocess {
  const queryClient = useQueryClient();
  const sendingRef = useRef(false);
  const [notice, setNotice] = useState<ReprocessNotice | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      reprocessReading(queryClient, id, expectedLayoutOf(queryClient.getQueryData<Identity | null>(whoamiQueryKey))),
    networkMode: "always",
    retry: 0,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: readingQueryKey(id) }),
        queryClient.invalidateQueries({ queryKey: ["library"] }),
      ]),
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
