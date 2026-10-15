import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { NetworkError, isUnauthorized } from "../api/errors";
import { writeDesk } from "../api/desk";
import {
  DESK_FULL_COPY,
  DESK_NOT_READY_COPY,
  DESK_QUERY_ROOT,
  deskIsFullFor,
  onDeskAfterWrite,
  onDeskQueryKey,
  type DeskWriteOutcome,
  type OnDeskEntry,
} from "../desk";
import { onDeskQueryOptions } from "../on-desk-query";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf, readingQueryKey } from "../reading";
import { Icon } from "./Icon";

// Put on desk / Take off desk (reading-lite-kl7y.6), on library cards and
// above the reading's title. A `button` with `aria-pressed` (acceptance
// matrix, Keyboard and focus). Pressed is the reading's `desk_position` as
// the backend last served it, so the label changes only once the refetch
// lands: the mutation stays pending through `onSettled`, which invalidates
// the desk, the library and the reading even when the reader has left.
//
// At the cap the toggle is disabled and says why in visible text. The cap is
// known from what is on the desk (on-desk-query.ts): GET /api/desk in the
// browser, or the desk page's own read, then each write's answer, less a
// reading a 404 says is gone. A 409 `desk_full` from a desk another tab filled says the
// same thing inline, and the refetch that follows disables the rest.
//
// `compact` is the desk page's own control for a reading already there: an
// icon button named "Take off desk", with no standing note.

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
  title?: string;
  desk_position?: number;
}

export function DeskToggle({
  reading,
  className,
  compact = false,
}: {
  reading: DeskToggleReading;
  className?: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const noteId = useId();
  const noticeId = useId();
  const sendingRef = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data: knownDesk } = useQuery(onDeskQueryOptions(queryClient, identity));
  const on = reading.desk_position !== undefined;
  const full = !on && deskIsFullFor(reading.id, knownDesk);

  const mutation = useMutation({
    mutationFn: (put: boolean) =>
      writeDesk(queryClient, reading.id, put, expectedLayoutOf(queryClient.getQueryData<Identity | null>(whoamiQueryKey))),
    retry: 0,
    onSuccess: (outcome) => {
      if (outcome.kind === "desk") {
        const written: OnDeskEntry = reading.title === undefined ? { id: reading.id } : { id: reading.id, title: reading.title };
        queryClient.setQueryData<OnDeskEntry[]>(onDeskQueryKey, (known) => onDeskAfterWrite(known, outcome.desk, written));
      }
      // A reading purged elsewhere left the desk with it; a desk that still
      // counts it would hold every other toggle at the cap.
      if (outcome.kind === "not-found") {
        queryClient.setQueryData<OnDeskEntry[]>(onDeskQueryKey, (desk) => desk?.filter((entry) => entry.id !== reading.id));
      }
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

  // A write's refusal goes in a status region that is always mounted, so its
  // text is what changes: one that mounts with its text already in it is not
  // reliably announced (ReadingPage.tsx, SaveNoticeBanner). The standing note
  // gives way to it.
  const said = notice ? noticeCopy(notice) : null;
  const note = said || (compact && on) ? null : full ? DESK_FULL_COPY : on ? "On your desk" : null;
  const describedBy = [note ? noteId : null, said ? noticeId : null].filter(Boolean).join(" ");
  const label = on ? "Take off desk" : "Put on desk";
  const iconOnly = compact && on;
  return (
    <div className={className ? `desk-toggle ${className}` : "desk-toggle"}>
      <button
        type="button"
        className={iconOnly ? "button button-icon" : "button button-quiet"}
        aria-pressed={on}
        aria-label={iconOnly ? label : undefined}
        disabled={full}
        aria-disabled={mutation.isPending || undefined}
        aria-describedby={describedBy || undefined}
        onClick={toggle}
      >
        {iconOnly ? <Icon name="close" size={14} strokeWidth={2} /> : label}
      </button>
      {note ? (
        <span id={noteId} className="desk-toggle-note">
          {note}
        </span>
      ) : null}
      <span id={noticeId} className="desk-toggle-note" role="status">
        {said}
      </span>
    </div>
  );
}
