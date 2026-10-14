import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { discardInboxItem, promoteInboxItem } from "./api/inbox";
import { DESK_QUERY_ROOT } from "./desk";
import { whoamiQueryKey, type Identity } from "./identity";
import {
  inboxItemQueryKey,
  inboxQueryKey,
  inboxWriteEffect,
  type DiscardOutcome,
  type InboxListResult,
  type InboxWriteEffect,
  type PromoteOutcome,
} from "./inbox";
import { expectedLayoutOf, readingQueryKey } from "./reading";
import { ConfirmDialog } from "./components/ConfirmDialog";

export interface InboxWriteHandlers {
  onPromoted?: (outcome: Extract<PromoteOutcome, { kind: "accepted" | "existing" }>) => void | Promise<void>;
  onDiscarded?: () => void | Promise<void>;
}

export type InboxWriteRefusal =
  | Exclude<PromoteOutcome, { kind: "accepted" | "existing" }>
  | Exclude<DiscardOutcome, { kind: "discarded" }>;

export interface InboxWrites {
  promote: () => void;
  askDiscard: () => void;
  pending: boolean;
  promotePaused: boolean;
  promoteError: unknown;
  discardError: unknown;
  refusal: InboxWriteRefusal | null;
  reset: () => void;
  /** Focus returns here when the confirm dialog closes. */
  discardAnchor: RefObject<HTMLButtonElement | null>;
  discardDialog: ReactNode;
}

export function useInboxWrites(id: string, handlers?: InboxWriteHandlers): InboxWrites {
  const queryClient = useQueryClient();
  const writingRef = useRef(false);
  const discardAnchor = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<InboxWriteRefusal | null>(null);

  const promoteMutation = useMutation({
    mutationFn: () => promoteInboxItem(queryClient, id, tenantOf(queryClient)),
  });
  const discardMutation = useMutation({
    mutationFn: () => discardInboxItem(queryClient, id, tenantOf(queryClient)),
    networkMode: "always",
    retry: 0,
  });

  function promote() {
    if (writingRef.current) return;
    setRefusal(null);
    writingRef.current = true;
    promoteMutation.mutate(undefined, {
      onSuccess: async (outcome) => {
        await settleInboxWrite(queryClient, id, outcome);
        if (outcome.kind === "accepted" || outcome.kind === "existing") {
          await handlers?.onPromoted?.(outcome);
          return;
        }
        setRefusal(outcome);
      },
      onSettled: () => {
        writingRef.current = false;
      },
    });
  }

  function askDiscard() {
    if (writingRef.current) return;
    setConfirming(true);
  }

  function discardNow() {
    if (writingRef.current) return;
    setRefusal(null);
    writingRef.current = true;
    discardMutation.mutate(undefined, {
      onSuccess: async (outcome) => {
        await settleInboxWrite(queryClient, id, outcome);
        if (outcome.kind === "discarded") {
          await handlers?.onDiscarded?.();
          return;
        }
        setRefusal(outcome);
      },
      onSettled: () => {
        writingRef.current = false;
      },
    });
  }

  function reset() {
    promoteMutation.reset();
    discardMutation.reset();
    setRefusal(null);
  }

  return {
    promote,
    askDiscard,
    pending: promoteMutation.isPending || discardMutation.isPending,
    promotePaused: promoteMutation.isPaused,
    promoteError: promoteMutation.error,
    discardError: discardMutation.error,
    refusal,
    reset,
    discardAnchor,
    discardDialog: confirming ? (
      <ConfirmDialog
        title="Discard this item?"
        confirmLabel="Discard"
        returnFocus={() => discardAnchor.current}
        onClose={() => setConfirming(false)}
        onConfirm={discardNow}
      >
        <p>The staged Markdown is deleted from your inbox. Nothing is added to your library.</p>
      </ConfirmDialog>
    ) : null,
  };
}

function tenantOf(queryClient: QueryClient): string | undefined {
  return expectedLayoutOf(queryClient.getQueryData<Identity | null>(whoamiQueryKey));
}

async function settleInboxWrite(
  queryClient: QueryClient,
  id: string,
  outcome: PromoteOutcome | DiscardOutcome,
): Promise<void> {
  const userId = queryClient.getQueryData<Identity | null>(whoamiQueryKey)?.user_id ?? "";
  const effect: InboxWriteEffect = inboxWriteEffect(outcome);
  if (effect === "drop") {
    queryClient.setQueriesData<InboxListResult>({ queryKey: inboxQueryKey(userId), exact: true }, (previous) =>
      previous?.state === "ready"
        ? {
            state: "ready",
            value: { ...previous.value, items: previous.value.items.filter((item) => item.id !== id) },
          }
        : previous,
    );
  } else {
    await queryClient.invalidateQueries({ queryKey: inboxItemQueryKey(userId, id), exact: true });
  }
  const readingId = readingIdOf(outcome);
  if (readingId !== undefined) queryClient.removeQueries({ queryKey: readingQueryKey(readingId) });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: inboxQueryKey(userId), exact: true }),
    queryClient.invalidateQueries({ queryKey: DESK_QUERY_ROOT }),
    readingId === undefined ? undefined : queryClient.invalidateQueries({ queryKey: ["library"] }),
  ]);
}

function readingIdOf(outcome: PromoteOutcome | DiscardOutcome): string | undefined {
  if (outcome.kind === "accepted" || outcome.kind === "existing") return outcome.id;
  if (outcome.kind === "unavailable" && outcome.id !== undefined) return outcome.id;
  return undefined;
}
