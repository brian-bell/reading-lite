import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { NetworkError, isUnauthorized } from "../api/errors";
import { writeDesk } from "../api/desk";
import {
  DESK_FULL_COPY,
  DESK_NOT_READY_COPY,
  DESK_QUERY_ROOT,
  deskIdsQueryKey,
  deskIsFullFor,
  type DeskWriteOutcome,
} from "../desk";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf, readingQueryKey } from "../reading";

// Put on desk / Take off desk (reading-lite-kl7y.6), on library cards and
// above the reading's title. A `button` with `aria-pressed` (acceptance
// matrix, Keyboard and focus). Pressed is the reading's `desk_position` as
// the backend last served it, so the label changes only once the refetch
// lands: the mutation stays pending through `onSettled`, which invalidates
// the desk, the library and the reading even when the reader has left.
//
// At the cap the toggle is disabled and says why in visible text. The cap is
// known from the last write's answer (desk.ts); a 409 `desk_full` from a desk
// another tab filled says the same thing inline.

type Notice = Exclude<DeskWriteOutcome, { kind: "desk" | "not-found" }> | { kind: "failed" };

function noticeCopy(notice: Notice): string {
  switch (notice.kind) {
    case "full":
      return DESK_FULL_COPY;
    case "not-ready":
      return DESK_NOT_READY_COPY;
    case "forbidden":
      return "You don't have permission to change the desk.";
    case "account-changed":
      return "This tab is signed in to a different account than the page expects.";
    case "failed":
      return "Couldn't change the desk. Try again.";
  }
}

export interface DeskToggleReading {
  id: string;
  desk_position?: number;
}

export function DeskToggle({ reading, className }: { reading: DeskToggleReading; className?: string }) {
  const queryClient = useQueryClient();
  const noteId = useId();
  const sendingRef = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const { data: knownDesk } = useQuery<string[]>({ queryKey: deskIdsQueryKey, queryFn: skipToken, staleTime: Infinity });
  const on = reading.desk_position !== undefined;
  const full = !on && deskIsFullFor(reading.id, knownDesk);

  const mutation = useMutation({
    mutationFn: (put: boolean) =>
      writeDesk(queryClient, reading.id, put, expectedLayoutOf(queryClient.getQueryData<Identity | null>(whoamiQueryKey))),
    retry: 0,
    onSuccess: (outcome) => {
      if (outcome.kind === "desk") queryClient.setQueryData(deskIdsQueryKey, outcome.desk);
    },
    onSettled: (_outcome, error) => {
      if (error instanceof NetworkError && error.offline) return;
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: DESK_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: ["library"] }),
        queryClient.invalidateQueries({ queryKey: readingQueryKey(reading.id) }),
      ]);
    },
  });

  function toggle() {
    if (sendingRef.current || full) return;
    sendingRef.current = true;
    setNotice(null);
    mutation
      .mutateAsync(!on)
      .then(
        (outcome) => {
          // A 404 shows itself: the refetch renders the reading's not-found
          // state, or drops the card.
          if (outcome.kind !== "desk" && outcome.kind !== "not-found") setNotice(outcome);
        },
        // A 401 is the mutation cache's (auth/session.ts): the shell replaces the page.
        (error: unknown) => {
          if (!isUnauthorized(error)) setNotice({ kind: "failed" });
        },
      )
      .finally(() => {
        sendingRef.current = false;
      });
  }

  const note = full ? DESK_FULL_COPY : notice ? noticeCopy(notice) : on ? "On your desk" : null;
  return (
    <div className={className ? `desk-toggle ${className}` : "desk-toggle"}>
      <button
        type="button"
        className="button button-quiet"
        aria-pressed={on}
        disabled={full}
        aria-disabled={mutation.isPending || undefined}
        aria-describedby={note ? noteId : undefined}
        onClick={toggle}
      >
        {on ? "Take off desk" : "Put on desk"}
      </button>
      {note ? (
        <span id={noteId} className="desk-toggle-note" role={notice ? "status" : undefined}>
          {note}
        </span>
      ) : null}
    </div>
  );
}
