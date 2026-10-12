import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { NetworkError, isUnauthorized } from "../api/errors";
import { writeDesk } from "../api/desk";
import { DESK_QUERY_ROOT, onDeskAfterWrite, onDeskQueryKey, sessionPlaceOf, type OnDeskEntry } from "../desk";
import { whoamiQueryKey, type Identity } from "../identity";
import { onDeskQueryOptions } from "../on-desk-query";
import { expectedLayoutOf, readingQueryKey } from "../reading";
import { Icon } from "./Icon";

// The session bar (design spec, Screens: Session bar), above the title of a
// reading on the desk: "On your desk · n of m", the next reading's title, and
// Done and Pause. Done takes this reading off the desk (DELETE /api/desk/:id)
// and opens the next one, or, on the last, goes back to the desk, which is
// then clear of this session. Pause goes back to the desk and leaves it as
// it is. Where the reading sits comes from what is on the desk
// (on-desk-query.ts), which the reading route reads during the server
// render; until it is known the bar names the reading's own position.

export function SessionBar({ reading }: { reading: { id: string; desk_position: number } }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const { data: onDesk } = useQuery(onDeskQueryOptions(queryClient, identity));
  const place = onDesk ? sessionPlaceOf(reading.id, onDesk) : undefined;
  const sendingRef = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => writeDesk(queryClient, reading.id, false, expectedLayoutOf(identity)),
    retry: 0,
    onSuccess: (outcome) => {
      if (outcome.kind === "desk") {
        queryClient.setQueryData<OnDeskEntry[]>(onDeskQueryKey, (known) => onDeskAfterWrite(known, outcome.desk));
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

  function done() {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setFailed(null);
    const next = place?.next;
    mutation
      .mutateAsync()
      .then(
        (outcome) => {
          if (outcome.kind === "forbidden") setFailed("You don't have permission to change the desk.");
          else if (outcome.kind === "account-changed") {
            setFailed("This tab is signed in to a different account than the page expects.");
          } else if (next) void navigate({ to: "/readings/$id", params: { id: next.id } });
          else void navigate({ to: "/" });
        },
        (error: unknown) => {
          if (!isUnauthorized(error)) setFailed("Couldn't take this reading off the desk. Try again.");
        },
      )
      .finally(() => {
        sendingRef.current = false;
      });
  }

  const position = place?.position ?? reading.desk_position;
  return (
    <div className="session-bar" role="group" aria-label="Session">
      <p className="session-bar-text">
        <Icon name="desk" size={14} strokeWidth={2} />
        <span>
          On your desk · {position}
          {place ? ` of ${place.count}` : null}
          {place?.next ? <span className="session-bar-next"> · next: {place.next.title ?? "untitled"}</span> : null}
        </span>
      </p>
      <div className="session-bar-actions">
        <button
          type="button"
          className="button button-primary"
          aria-disabled={mutation.isPending || place === undefined || undefined}
          onClick={() => {
            if (place !== undefined) done();
          }}
        >
          {place === undefined || place.next ? "Done, next" : "Done, clear the desk"}
        </button>
        <Link to="/" className="button">
          Pause
        </Link>
      </div>
      <p className="session-bar-notice" role="status">
        {failed}
      </p>
    </div>
  );
}
