import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { accountViewOf, type AccountView } from "../account-state";
import { clearDesk } from "../api/desk";
import { deskInboxFold, deskQuietOf } from "../inbox";
import { inboxQueryOptions } from "../inbox-query";
import { NetworkError, isUnauthorized } from "../api/errors";
import {
  DESK_CAP,
  DESK_QUERY_ROOT,
  agoLabel,
  needsYouLine,
  onDeskQueryKey,
  serializeVisitCookie,
  stageLabel,
  type DeskRead,
  type DeskResult,
  type OnDeskEntry,
  type Visit,
  type VisitAt,
} from "../desk";
import { deskQueryOptions } from "../desk-query";
import { needsProviderKey, whoamiQueryKey, type Identity } from "../identity";
import { whoamiQueryOptions } from "../identity-query";
import type { LibraryRow } from "../library";
import { libraryBadge } from "../library-card";
import { useNeedsYou } from "../needs-you-dismissals";
import { formatUsd, keyStateOf, type ProviderSettings, type ProviderUsage } from "../provider";
import { providerQueryOptions, providerUsageQueryOptions } from "../provider-query";
import { expectedLayoutOf } from "../reading";
import { dateOn, hostnameOf } from "../reading-presentation";
import { relationshipsQueryKey } from "../relationships";
import { librarySchedule } from "../status-refresh";
import { ConnectKeyLink } from "./ConnectKey";
import { DeskInboxSection } from "./DeskInbox";
import { DeskToggle } from "./DeskToggle";
import { Icon } from "./Icon";
import { PageHeading, PageStateFocus, focusPageHeading } from "./PageHeading";
import { AccountChanged, Forbidden, InlineNotice, LoadingRegion, OfflineNotice, ServerError } from "./ReadingStates";
import { SignInPage } from "./SignInPage";
import { useStatusWatch } from "./use-status-watch";

const HEADING = "Desk";

/** `/`: the sign-in form in place when signed out, the desk when signed in. */
export function DeskHome({ visit }: { visit: VisitAt }) {
  const { data: identity } = useQuery(whoamiQueryOptions());
  if (identity === null) return <SignInPage next="/" landing />;
  // Identity could not be determined: the shell shows neither account state.
  if (identity === undefined) {
    return (
      <div className="page">
        <PageHeading>{HEADING}</PageHeading>
      </div>
    );
  }
  return <DeskPage visit={visit} identity={identity} />;
}

function DeskPage({ visit, identity }: { visit: VisitAt; identity: Identity }) {
  const queryClient = useQueryClient();
  useVisitCookie(visit.next);
  const watch = useStatusWatch<DeskResult>({ keyOf: deskWatchKeyOf, schedule: librarySchedule });
  const { data, error, fetchStatus, refetch } = useQuery(deskQueryOptions(queryClient, visit, identity, watch.options));
  useGraphRefreshOnSettle(data);
  const checkFailed =
    (watch.status === "watching" || watch.status === "failures") && !(error instanceof NetworkError && error.offline);
  const view = accountViewOf({ data, error: checkFailed ? null : error, fetchStatus });
  const stoppedChecking = watch.status === "failures" && error !== null;
  const retry = () => void refetch();
  return (
    <PageStateFocus kind={view.kind}>
      {pageFor(view, { visit, identity, retry, stoppedChecking })}
    </PageStateFocus>
  );
}

function pageFor(
  view: AccountView<DeskRead>,
  props: { visit: VisitAt; identity: Identity; retry: () => void; stoppedChecking: boolean },
) {
  switch (view.kind) {
    case "forbidden":
      return <Forbidden />;
    case "account-changed":
      return <AccountChanged actingTenant={view.actingTenant} />;
    case "server-error":
      return <ServerError message={view.message} onRetry={props.retry} />;
    default:
      return (
        <div className="page desk">
          <PageHeading>{HEADING}</PageHeading>
          {view.kind === "offline" ? <OfflineNotice onRetry={props.retry} /> : null}
          {view.kind === "ready" && props.stoppedChecking ? (
            <InlineNotice message="Couldn't check status." live={false} />
          ) : null}
          {view.kind === "loading" ? (
            <LoadingRegion className="library-message" />
          ) : view.value === undefined ? null : (
            <DeskSections desk={view.value} visit={props.visit} identity={props.identity} />
          )}
        </div>
      );
  }
}

/** The visit's cookie, written once the page has hydrated: the next render starts from it. */
function useVisitCookie(next: Visit) {
  const { previous, latest } = next;
  useEffect(() => {
    document.cookie = serializeVisitCookie({ previous, latest }, { secure: window.location.protocol === "https:" });
  }, [previous, latest]);
}

/** What the desk's status watch follows: its own query, while anything on it is processing. */
function deskWatchKeyOf(data: DeskResult | undefined, queryHash: string): string | null {
  if (data?.state !== "ready" || data.value.processing.length === 0) return null;
  return queryHash;
}

/** A processing row that settled may have joined the graph and the library's other pages. */
function useGraphRefreshOnSettle(data: DeskResult | undefined) {
  const queryClient = useQueryClient();
  const processing = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (data?.state !== "ready") return;
    const was = processing.current;
    processing.current = new Set(data.value.processing.map((row) => row.id));
    if ([...was].some((id) => !processing.current.has(id))) {
      void queryClient.invalidateQueries({ queryKey: relationshipsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    }
  }, [data, queryClient]);
}

function DeskSections({ desk, visit, identity }: { desk: DeskRead; visit: VisitAt; identity: Identity }) {
  const queryClient = useQueryClient();
  const provider = useQuery(providerQueryOptions(queryClient, identity));
  const usage = useQuery(providerUsageQueryOptions(queryClient, identity));
  const inbox = useQuery(inboxQueryOptions(queryClient, identity));
  const fold = deskInboxFold(accountViewOf({ data: inbox.data, error: inbox.error, fetchStatus: inbox.fetchStatus }));
  const settings = provider.data?.state === "ready" ? provider.data.value : undefined;
  const keyRejected = settings?.credential?.status === "invalid";
  const now = visit.next.latest;
  const needsYou = useNeedsYou(desk, now);
  const needsYouCount = needsYou.total + (keyRejected ? 1 : 0);
  const quiet = deskQuietOf(
    {
      needsYou: needsYouCount,
      processing: desk.processing_total,
      onDesk: desk.on_desk.length,
      readySince: desk.ready_since_total,
    },
    fold,
  );

  return (
    <>
      {needsYouCount > 0 ? (
        <DeskSection title="Needs you" count={needsYouCount} tone="danger">
          {keyRejected ? (
            <DeskRow title="Key rejected by OpenAI" note="Processing is paused until you replace it.">
              <Link to="/account/provider" className="button">
                Replace key
              </Link>
            </DeskRow>
          ) : null}
          {needsYou.rows.map(({ row, dismiss }) => (
            <DeskRow key={row.id} title={titleOf(row)} note={needsYouLine(row)} to={row.id}>
              {dismiss ? (
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => {
                    focusPageHeading({ preventScroll: true });
                    dismiss(Date.now());
                  }}
                >
                  Dismiss
                </button>
              ) : null}
            </DeskRow>
          ))}
          <MoreRow shown={needsYou.rows.length} total={needsYou.total} />
        </DeskSection>
      ) : null}
      <DeskInboxSection fold={fold} onRetry={() => void inbox.refetch()} Section={DeskSection} />
      {desk.processing_total > 0 ? (
        <DeskSection title="Processing" count={desk.processing_total}>
          {desk.processing.map((row) => (
            <DeskRow key={row.id} title={titleOf(row)} note={processingLine(row, now)} to={row.id} live />
          ))}
          <MoreRow shown={desk.processing.length} total={desk.processing_total} />
        </DeskSection>
      ) : null}
      {quiet === "empty" ? <DeskEmpty identity={identity} /> : null}
      {quiet === "occupied" ? <OnYourDesk rows={desk.on_desk} /> : null}
      {desk.ready_since.length > 0 ? (
        <DeskSection
          title={`Ready since ${dateOn(new Date(visit.since).toISOString())}`}
          count={desk.ready_since_total}
          note="Processed since your last visit."
        >
          {desk.ready_since.map((row) => (
            <DeskRow key={row.id} title={titleOf(row)} note={row.tldr ?? hostnameOf(row.url)} to={row.id}>
              <DeskToggle reading={deskReadingOf(row)} />
            </DeskRow>
          ))}
          {desk.ready_since_total > desk.ready_since.length ? (
            <li className="desk-row desk-row-more">
              <Link to="/library" className="button button-quiet">
                Show all {desk.ready_since_total}
              </Link>
            </li>
          ) : null}
        </DeskSection>
      ) : null}
      <div className="desk-tiles">
        <ProviderTile
          settings={settings}
          usage={usage.data?.state === "ready" ? usage.data.value : undefined}
          failed={provider.isError}
          onRetry={() => void provider.refetch()}
        />
      </div>
    </>
  );
}

/** A reading with no title yet (pending, failed) is named by its URL, as on the library. */
function titleOf(row: LibraryRow): string {
  return row.title ?? row.url;
}

function processingLine(row: LibraryRow, now: number): string {
  const ago = agoLabel(row.created_at, now);
  const stage = stageLabel(row.active_attempt?.stage);
  return ago ? `${stage} · saved ${ago}` : stage;
}

function deskReadingOf(row: LibraryRow) {
  return {
    id: row.id,
    ...(row.title === undefined ? {} : { title: row.title }),
    ...(row.desk_position === undefined ? {} : { desk_position: row.desk_position }),
  };
}

function MoreRow({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <li className="desk-row desk-row-more">
      <p className="desk-row-note">and {total - shown} more</p>
    </li>
  );
}

/** Nothing anywhere: say so, with the way on. A reader with no key yet connects one first. */
function DeskEmpty({ identity }: { identity: Identity }) {
  return (
    <div className="library-message">
      <p className="auth-lede">Nothing needs you.</p>
      <div className="form-actions">
        {needsProviderKey(identity) ? (
          <ConnectKeyLink primary />
        ) : (
          <Link to="/save" className="button button-primary">
            Save a reading
          </Link>
        )}
        <Link to="/library" className="button">
          Library
        </Link>
      </div>
    </div>
  );
}

/**
 * The readings on the desk, in position order: Start on the first, and each
 * one's own Take off desk. A reading that went pending or failed after it was
 * put there stays, with its badge. Clear the desk takes them all off.
 */
function OnYourDesk({ rows }: { rows: readonly LibraryRow[] }) {
  return (
    <DeskSection
      title="On your desk"
      tone="focus"
      aside={<DeskSlots filled={rows.length} />}
      note={rows.length ? `${rows.length} of ${DESK_CAP}. Open the first to start a session.` : undefined}
      footer={rows.length ? <ClearDesk /> : undefined}
    >
      {rows.length === 0 ? (
        <li className="desk-row desk-row-empty">
          <p className="desk-row-note">Nothing yet. Put a reading here from the library, or from what arrived below.</p>
        </li>
      ) : (
        rows.map((row, index) => {
          const badge = libraryBadge(row);
          return (
            <DeskRow
              key={row.id}
              title={titleOf(row)}
              note={row.tldr ?? hostnameOf(row.url)}
              to={row.id}
              index={index + 1}
              badge={badge ? <span className={`status-badge status-badge-${badge.kind}`}>{badge.label}</span> : undefined}
            >
              {index === 0 ? (
                <Link to="/readings/$id" params={{ id: row.id }} className="button button-primary">
                  Start
                </Link>
              ) : null}
              <DeskToggle reading={deskReadingOf(row)} compact />
            </DeskRow>
          );
        })
      )}
    </DeskSection>
  );
}

function ClearDesk() {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      clearDesk(queryClient, expectedLayoutOf(queryClient.getQueryData<Identity | null>(whoamiQueryKey))),
    retry: 0,
    onSuccess: (outcome) => {
      if (outcome.kind === "desk") queryClient.setQueryData<OnDeskEntry[]>(onDeskQueryKey, []);
    },
    onSettled: (_outcome, error) => {
      if (error instanceof NetworkError && error.offline) return;
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: DESK_QUERY_ROOT }),
        queryClient.invalidateQueries({ queryKey: ["library"] }),
        queryClient.invalidateQueries({ queryKey: ["reading"] }),
      ]);
    },
  });
  function clear() {
    if (mutation.isPending) return;
    setFailed(null);
    mutation.mutateAsync().then(
      (outcome) => {
        if (outcome.kind === "forbidden") setFailed("You don't have permission to change the desk.");
        else if (outcome.kind === "account-changed") {
          setFailed("This tab is signed in to a different account than the page expects.");
        }
      },
      (error: unknown) => {
        if (!isUnauthorized(error)) setFailed("Couldn't clear the desk. Try again.");
      },
    );
  }
  return (
    <div className="desk-section-footer">
      <button
        type="button"
        className="button button-quiet"
        aria-disabled={mutation.isPending || undefined}
        onClick={clear}
      >
        Clear the desk
      </button>
      <p className="desk-toggle-note" role="status">
        {failed}
      </p>
    </div>
  );
}

function DeskSection({
  title,
  count,
  note,
  tone,
  aside,
  footer,
  children,
}: {
  title: string;
  /** Shown beside the title; the list itself carries the count for assistive technology. */
  count?: number;
  note?: string;
  /** `danger` rules the section's left edge; `focus` lifts it as the page's centre. */
  tone?: "danger" | "focus";
  aside?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const className = tone ? `desk-section desk-section-${tone}` : "desk-section";
  return (
    <section className={className} aria-label={title}>
      <div className="desk-section-head">
        <h2 className="desk-section-title">{title}</h2>
        {count !== undefined ? (
          <span className="desk-section-count" aria-hidden="true">
            {count}
          </span>
        ) : null}
        {aside ? <div className="desk-section-aside">{aside}</div> : null}
        {note ? <p className="form-hint desk-section-note">{note}</p> : null}
      </div>
      <ul className="desk-rows">{children}</ul>
      {footer}
    </section>
  );
}

/**
 * One row. With `to`, the title links to the reading and is stretched over
 * the row, so the row is one target; its actions are raised above it.
 */
function DeskRow({
  title,
  note,
  to,
  index,
  live,
  badge,
  children,
}: {
  title: string;
  note: string;
  to?: string;
  /** The reading's place on the desk. */
  index?: number;
  /** A running attempt: a live mark before the title. */
  live?: boolean;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  const marked = index !== undefined || live;
  const className = ["desk-row", to ? "desk-row-linked" : "", marked ? "desk-row-marked" : ""].filter(Boolean).join(" ");
  return (
    <li className={className}>
      {index !== undefined ? (
        <span className="desk-row-index" aria-hidden="true">
          {index}
        </span>
      ) : live ? (
        <span className="desk-row-live" aria-hidden="true" />
      ) : null}
      <div className="desk-row-text">
        {badge ? <p className="desk-row-badge">{badge}</p> : null}
        <p className="desk-row-title">
          {to ? (
            <Link to="/readings/$id" params={{ id: to }}>
              {title}
            </Link>
          ) : (
            title
          )}
        </p>
        <p className="desk-row-note">{note}</p>
      </div>
      {children ? (
        <div className="desk-row-actions">{children}</div>
      ) : to ? (
        <span className="desk-row-chevron" aria-hidden="true">
          <Icon name="chevron" size={16} strokeWidth={1.75} />
        </span>
      ) : null}
    </li>
  );
}

/** The desk's three slots, filled left to right. */
function DeskSlots({ filled }: { filled: number }) {
  return (
    <span className="desk-slots" aria-hidden="true">
      {Array.from({ length: DESK_CAP }, (_, i) => (
        <span key={i} className={i < filled ? "desk-slot desk-slot-filled" : "desk-slot"} />
      ))}
    </span>
  );
}

/** The provider at a glance: the key's state, and today's spend against the limit when connected. */
function ProviderTile({
  settings,
  usage,
  failed,
  onRetry,
}: {
  settings: ProviderSettings | undefined;
  usage: ProviderUsage | undefined;
  failed: boolean;
  onRetry: () => void;
}) {
  if (settings === undefined) {
    return (
      <section className="desk-tile" aria-label="Provider">
        <h2 className="desk-tile-eyebrow">Provider</h2>
        {failed ? (
          <InlineNotice message="Provider settings aren't available right now." onAction={onRetry} />
        ) : (
          <LoadingRegion className="desk-tile-meta" />
        )}
      </section>
    );
  }
  const key = keyStateOf(settings, false);
  const tone = key.kind === "connected" ? "positive" : key.kind === "invalid" ? "danger" : "muted";
  const spent =
    usage && usage.effective_daily_spend_microdollars > 0
      ? Math.min(100, (usage.charged_microdollars / usage.effective_daily_spend_microdollars) * 100)
      : 0;
  return (
    <section className="desk-tile" aria-label="Provider">
      <h2 className="desk-tile-eyebrow">Provider</h2>
      <p className="desk-tile-title">
        <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />
        {key.kind === "connected" ? "Connected" : key.kind === "invalid" ? "Key rejected by OpenAI" : "No key connected"}
        {key.kind === "connected" ? <span className="desk-tile-title-meta">OpenAI key ending {key.lastFour}</span> : null}
      </p>
      {key.kind === "connected" ? (
        usage ? (
          <>
            <div className="spend-meter" aria-hidden="true">
              <span className="spend-meter-fill" style={{ width: `${spent}%` }} />
            </div>
            <p className="desk-tile-meta">
              {formatUsd(usage.charged_microdollars)} of {formatUsd(usage.effective_daily_spend_microdollars)} today ·
              resets at midnight UTC
            </p>
          </>
        ) : null
      ) : key.kind === "invalid" ? (
        <p className="desk-tile-meta">
          Replace the key to resume processing. Requests already sent may still finish and be charged.
        </p>
      ) : (
        <p className="desk-tile-meta">Summaries and embeddings run with your own OpenAI key.</p>
      )}
      <div className="desk-tile-actions">
        <Link to="/account/provider" className="button">
          {key.kind === "connected" ? "Settings" : key.kind === "invalid" ? "Replace key" : "Connect a key"}
        </Link>
      </div>
    </section>
  );
}