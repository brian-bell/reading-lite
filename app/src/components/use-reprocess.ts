import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { NetworkError, isUnauthorized } from "../api/errors";
import { reprocessReading } from "../api/reprocess";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf, readingQueryKey } from "../reading";
import type { ReprocessOutcome } from "../reprocess";

// Retry on a failed reading and Reprocess on a ready one (#410): one request,
// POST /api/readings/:id/reprocess, sent only when the reader asks.
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

/** Which control asked: Retry sends at once; Reprocess has already been confirmed. */
export type ReprocessTrigger = "retry" | "reprocess";

/** What stays on the page after an answer that did not start an attempt. */
export type ReprocessNotice =
  | Exclude<ReprocessOutcome, { kind: "started" | "not-found" | "forbidden" | "account-changed" }>
  | { kind: "offline" }
  | { kind: "server-error"; message: string };

/** What replaces the page: the shared 403 and 412 states. */
export type ReprocessReplacement = Extract<ReprocessOutcome, { kind: "forbidden" | "account-changed" }>;

interface Answer {
  /** The reading it belongs to: the route component is reused across readings. */
  id: string;
  trigger: ReprocessTrigger;
  notice: ReprocessNotice | null;
  replacement: ReprocessReplacement | null;
  started: boolean;
}

export interface Reprocess {
  send: (trigger: ReprocessTrigger) => void;
  /** Whether a request is in flight; its controls are `aria-disabled`. */
  sending: boolean;
  /** The control that asked last, for "Try again". */
  trigger: ReprocessTrigger | null;
  notice: ReprocessNotice | null;
  replacement: ReprocessReplacement | null;
  /** A Retry started an attempt: the card that replaced the pressed button takes focus. */
  retryStarted: boolean;
}

export function useReprocess(id: string): Reprocess {
  const queryClient = useQueryClient();
  const sendingRef = useRef(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const mutation = useMutation({
    mutationFn: (readingId: string) =>
      reprocessReading(
        queryClient,
        readingId,
        expectedLayoutOf(queryClient.getQueryData<Identity | null>(whoamiQueryKey)),
      ),
    networkMode: "always",
    retry: 0,
    onSettled: (_outcome, _error, readingId) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: readingQueryKey(readingId) }),
        queryClient.invalidateQueries({ queryKey: ["library"] }),
      ]),
  });

  function send(trigger: ReprocessTrigger) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setAnswer(null);
    mutation
      .mutateAsync(id)
      .then(
        (outcome) => setAnswer({ id, trigger, ...answerOf(outcome) }),
        // A 401 is the mutation cache's (auth/session.ts): the shell replaces
        // the page, and nothing here needs saying.
        (error: unknown) => {
          if (!isUnauthorized(error)) setAnswer({ id, trigger, started: false, replacement: null, notice: noticeOfError(error) });
        },
      )
      .finally(() => {
        sendingRef.current = false;
      });
  }

  const current = answer?.id === id ? answer : null;
  return {
    send,
    sending: mutation.isPending,
    trigger: current?.trigger ?? null,
    notice: current?.notice ?? null,
    replacement: current?.replacement ?? null,
    retryStarted: current?.started === true && current.trigger === "retry",
  };
}

function answerOf(outcome: ReprocessOutcome): Omit<Answer, "id" | "trigger"> {
  switch (outcome.kind) {
    case "started":
      return { started: true, notice: null, replacement: null };
    // The refetch renders the not-found state.
    case "not-found":
      return { started: false, notice: null, replacement: null };
    case "forbidden":
    case "account-changed":
      return { started: false, notice: null, replacement: outcome };
    default:
      return { started: false, notice: outcome, replacement: null };
  }
}

function noticeOfError(error: unknown): ReprocessNotice {
  if (error instanceof NetworkError && error.offline) return { kind: "offline" };
  return { kind: "server-error", message: error instanceof Error ? error.message : String(error) };
}
