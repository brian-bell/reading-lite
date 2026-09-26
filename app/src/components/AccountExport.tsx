import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { readRefusedBy, type AccountView } from "../account-state";
import { requestExport } from "../api/exports";
import { isUnauthorized, NetworkError } from "../api/errors";
import {
  EXPORT_ACTIVE,
  EXPORT_LIMITS,
  exportDownloadHref,
  exportFailureSentence,
  exportLimitSentence,
  exportsQueryKey,
  nextRequestAtMs,
  nextRequestSentence,
  type ArchiveExport,
  type ExportLatest,
  type ExportRequestOutcome,
  type ExportsResult,
} from "../archive-export";
import { whoamiQueryKey, type Identity } from "../identity";
import { expectedLayoutOf } from "../reading";
import { dateTimeOn } from "../reading-presentation";
import { Icon } from "./Icon";
import { InlineNotice, LoadingRegion, OfflineNotice } from "./ReadingStates";

// "Export your archive" on the account page (reading-lite-mxwx.5): the latest
// export's state, Request export, and the download once it is ready. The
// section carries its read's loading, offline, and server-error states, and
// a failed request's, itself; a refused read never reaches here (AccountPage's
// pageViewOf), and a refused request is stored as the read's result so the
// page shows the same state.
//
// While an export is queued or building the query reads the status again
// every ten seconds (exports-query.ts), and the status line below is a live
// region, so the change to ready is announced. The limits are stated with the
// section; a 409 or 429 says which one was met and when the next request is
// allowed. The download is a plain link: the archive can be large, and the
// browser streams it to disk under the backend's Content-Disposition.

export interface ExportSectionProps {
  view: AccountView<ExportLatest>;
  /** Reads the status again after a failed read. */
  onRetry: () => void;
}

export function ExportSection({ view, onRetry }: ExportSectionProps) {
  const queryClient = useQueryClient();
  const identity = queryClient.getQueryData<Identity | null>(whoamiQueryKey);
  const expectedTenant = expectedLayoutOf(identity);
  const exportsKey = exportsQueryKey(identity?.user_id ?? "");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const request = useMutation({
    mutationFn: (): Promise<ExportRequestOutcome> => requestExport(queryClient, expectedTenant),
    networkMode: "always",
    retry: 0,
    onSuccess: async (outcome) => {
      if (outcome.kind === "forbidden" || outcome.kind === "account-changed") {
        queryClient.setQueryData<ExportsResult>(exportsKey, readRefusedBy(outcome));
        return;
      }
      // Queued, or refused by a limit another tab met: either way the status
      // (and when the next request is allowed) has changed.
      await queryClient.invalidateQueries({ queryKey: exportsKey });
    },
  });

  const latest = view.kind === "ready" || view.kind === "offline" ? view.value : undefined;
  const current = latest?.export ?? null;
  const inProgress = current?.status === "queued" || current?.status === "building";
  const nextMs = latest ? nextRequestAtMs(latest, nowMs) : undefined;

  const outcome = request.data;
  // Each refusal is said only while it is still true: the 409 while the
  // other export is running, the 429 until the time it named. A 429 whose
  // time is unreadable is said but locks nothing; the backend still refuses.
  const activeRefusal = outcome?.kind === "active" && inProgress;
  const limitResetMs = outcome?.kind === "limited" ? Date.parse(outcome.resetAt ?? "") : Number.NaN;
  const limitRefusal =
    outcome?.kind === "limited" && !inProgress && !(limitResetMs <= nowMs) ? outcome : undefined;
  const heldUntilMs = Math.max(nextMs ?? 0, limitRefusal && !Number.isNaN(limitResetMs) ? limitResetMs : 0) || undefined;

  // The button comes back on by itself once the wait is over. Browsers store
  // setTimeout delays as a signed 32-bit int, so clamp and reschedule.
  useEffect(() => {
    if (heldUntilMs == null) return;
    const delay = Math.min(2_147_483_647, Math.max(0, heldUntilMs - Date.now()));
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [heldUntilMs]);

  // A 401 is the shell's page, so it is not repeated here.
  const failure = request.error == null || isUnauthorized(request.error) ? undefined : failureOf(request.error);
  const canRequest = latest !== undefined && !inProgress && heldUntilMs === undefined && !request.isPending;

  function send() {
    if (!canRequest) return;
    request.reset();
    request.mutate();
  }

  // Retry after a failed request reads the status again rather than asking
  // unasked: the failure may mean the status on screen is stale.
  function retryAfterFailure() {
    request.reset();
    onRetry();
  }

  return (
    <section className="account-section" aria-labelledby="export-heading">
      <h2 id="export-heading" className="account-section-title">
        Export your archive
      </h2>
      <p className="account-export-text">
        A zip of your whole library: every reading's record, summary, and relationships, with the captured Markdown
        and original files.
      </p>
      <p className="session-meta">{EXPORT_LIMITS}</p>
      {view.kind === "loading" ? <LoadingRegion /> : null}
      {failure ? (
        <InlineNotice
          message={
            failure.kind === "offline"
              ? "You're offline. The export wasn't requested."
              : "Something went wrong on our side. The export wasn't requested."
          }
          onAction={retryAfterFailure}
        >
          {failure.kind === "server-error" ? <p className="form-hint">{failure.message}</p> : null}
        </InlineNotice>
      ) : view.kind === "offline" ? (
        <OfflineNotice onRetry={onRetry} />
      ) : null}
      {view.kind === "server-error" ? (
        <InlineNotice message="Something went wrong on our side." onAction={onRetry}>
          <p className="form-hint">{view.message}</p>
        </InlineNotice>
      ) : null}
      {outcome?.kind === "unavailable" ? (
        <InlineNotice message="Exports can't be started right now. Try again in a few minutes." onAction={send} />
      ) : null}
      {activeRefusal ? (
        <p className="session-cap-warning" role="status">
          {EXPORT_ACTIVE}
        </p>
      ) : null}
      {limitRefusal ? (
        <p className="session-cap-warning" role="status">
          {exportLimitSentence(limitRefusal.resetAt)}
        </p>
      ) : null}
      {/* The latest export on the card surface sessions and tokens use: its
          badge, its sentence, then what can be done about it. The status
          region is always in the page, so each change the polling brings is
          announced; the badge repeats the sentence, so it is not read. */}
      <div className="account-export-card" hidden={latest === undefined}>
        {current ? (
          <span className={`status-badge status-badge-${current.status}`} aria-hidden="true">
            {EXPORT_BADGE[current.status]}
          </span>
        ) : null}
        <div className="account-export-status" role="status">
          {latest ? <ExportStatus current={current} /> : null}
        </div>
        {latest && !inProgress ? (
          <div className="form-actions">
            {current?.status === "ready" ? (
              // No `download` attribute: the backend's Content-Disposition makes
              // this a download, and Chromium sends an attribute download outside
              // the page's request handling.
              <a className="button button-primary button-leading-icon" href={exportDownloadHref(current.id)}>
                <Icon name="download" size={16} strokeWidth={2} />
                Download archive
              </a>
            ) : null}
            <button type="button" className="button" onClick={send} disabled={!canRequest}>
              {current?.status === "ready" ? "Request a new export" : "Request export"}
            </button>
          </div>
        ) : null}
        {latest && !inProgress && nextMs !== undefined && !limitRefusal ? (
          <p className="session-meta">{nextRequestSentence(nextMs)}</p>
        ) : null}
      </div>
    </section>
  );
}

/** The badge's word for each status: the text label the colour never stands in for. */
const EXPORT_BADGE: Record<ArchiveExport["status"], string> = {
  queued: "Queued",
  building: "Building",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
};

/** What the latest export is, in one or two sentences. */
function ExportStatus({ current }: { current: ArchiveExport | null }) {
  if (current === null) return <p>You haven't exported your library yet.</p>;
  switch (current.status) {
    case "queued":
      return <p>Export requested {timeOf(current.requested_at)}. It's waiting to start; this page updates as it goes.</p>;
    case "building":
      return <p>Building your archive. This page updates when it's ready.</p>;
    case "ready":
      return (
        <p>
          Your archive is ready.
          {current.expires_at ? ` You can download it until ${timeOf(current.expires_at)}.` : null}
        </p>
      );
    case "failed":
      return <p>{exportFailureSentence(current.error?.code)}</p>;
    case "expired":
      return <p>Your last archive expired{current.expires_at ? ` on ${timeOf(current.expires_at)}` : ""}. Request a new one to download your library.</p>;
    case "cancelled":
      return <p>Your last export was cancelled.</p>;
  }
}

function timeOf(iso: string): string {
  return dateTimeOn(iso) ?? iso;
}

type Failure = { kind: "offline" } | { kind: "server-error"; message: string };

function failureOf(error: unknown): Failure {
  if (error instanceof NetworkError && error.offline) return { kind: "offline" };
  const message = error instanceof Error && error.message !== "" ? error.message : String(error);
  return { kind: "server-error", message };
}
