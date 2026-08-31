import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  BrowserRouter,
  Link,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";

import {
  ApiError,
  fetchContentBlob,
  getReadingDiagnostics,
  getReading,
  getWhoami,
  listReadings,
  listSessions,
  logoutSession,
  redeemLoginLink,
  reprocessReading,
  requestLoginLink,
  revokeAllSessions,
  revokeSession,
  submitReading,
  type ContentKind
} from "./api";
import { captureMagicLinkCredential, clearMagicLinkCredential } from "./magic-link-credential";
import {
  consumeLoginReturnPath,
  rememberLoginReturnPath,
  safeReadingReturnPath
} from "./login-return-path";
import type {
  Connection,
  ListReading,
  ManifestStatus,
  ProcessingAttempt,
  ProcessingAttemptSummary,
  SessionListItem,
  WhoamiResponse
} from "./types";
import "./styles.css";

type AppProps = {
  initialPath?: string;
};

const pageSize = 20;

export function App({ initialPath }: AppProps) {
  useEffect(() => {
    localStorage.removeItem("reading-lite.bearerToken");
  }, []);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false
          }
        }
      })
  );
  const router = initialPath ? (
    <MemoryRouter initialEntries={[initialPath]}>
      <AppRoutes />
    </MemoryRouter>
  ) : (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );

  return <QueryClientProvider client={queryClient}>{router}</QueryClientProvider>;
}

function useIdentity() {
  return useQuery({
    queryKey: ["whoami"],
    queryFn: getWhoami
  });
}

function AppRoutes() {
  const identityQuery = useIdentity();
  const identity = identityQuery.data ?? null;

  return (
    <Shell identity={identity} onSignedOut={() => identityQuery.refetch()}>
      <Routes>
        <Route path="/login" element={<LoginPage identity={identity} identityQuery={identityQuery} />} />
        <Route path="/login/verify" element={<VerifyPage />} />
        <Route path="/auth/verify" element={<VerifyPage />} />
        <Route
          path="/account/security"
          element={<AccountSecurityRoute identity={identity} identityQuery={identityQuery} />}
        />
        <Route path="/" element={<HomeRoute identity={identity} identityQuery={identityQuery} />} />
        <Route
          path="/readings/:id"
          element={<ReadingRoute identity={identity} identityQuery={identityQuery} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function identityError(error: unknown): Error {
  return error instanceof Error ? error : new Error("failed to load identity");
}

function IdentityError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="error-message">
      <p>{error.message}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function HomeRoute({
  identity,
  identityQuery
}: {
  identity: WhoamiResponse | null;
  identityQuery: ReturnType<typeof useIdentity>;
}) {
  if (identity) return <ReadingList />;
  if (identityQuery.isPending || identityQuery.isFetching) return <StatusMessage>Loading</StatusMessage>;
  if (identityQuery.isError) {
    return (
      <IdentityError error={identityError(identityQuery.error)} onRetry={() => void identityQuery.refetch()} />
    );
  }
  return <LoginPage identity={identity} identityQuery={identityQuery} />;
}

function ReadingRoute({
  identity,
  identityQuery
}: {
  identity: WhoamiResponse | null;
  identityQuery: ReturnType<typeof useIdentity>;
}) {
  const location = useLocation();
  if (identity) return <ReadingDetail />;
  if (identityQuery.isPending || identityQuery.isFetching) return <StatusMessage>Loading</StatusMessage>;
  if (identityQuery.isError) {
    return (
      <IdentityError error={identityError(identityQuery.error)} onRetry={() => void identityQuery.refetch()} />
    );
  }
  const next = encodeURIComponent(location.pathname);
  return <Navigate to={`/login?next=${next}`} replace />;
}

function AccountSecurityRoute({
  identity,
  identityQuery
}: {
  identity: WhoamiResponse | null;
  identityQuery: ReturnType<typeof useIdentity>;
}) {
  const location = useLocation();
  if (identity) return <AccountSecurityPage onSignedOut={() => identityQuery.refetch()} />;
  if (identityQuery.isPending || identityQuery.isFetching) return <StatusMessage>Loading</StatusMessage>;
  if (identityQuery.isError) {
    return (
      <IdentityError error={identityError(identityQuery.error)} onRetry={() => void identityQuery.refetch()} />
    );
  }
  const next = encodeURIComponent(location.pathname);
  return <Navigate to={`/login?next=${next}`} replace />;
}

function Shell({
  children,
  identity,
  onSignedOut
}: {
  children: ReactNode;
  identity: WhoamiResponse | null;
  onSignedOut: () => void;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">reading-lite</div>
        <nav>
          <Link className="nav-link active" to="/">
            Readings
          </Link>
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          {identity ? <IdentityBar identity={identity} onSignedOut={onSignedOut} /> : null}
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

function IdentityBar({
  identity,
  onSignedOut
}: {
  identity: WhoamiResponse;
  onSignedOut: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <div className="identity-bar">
      <span>{identity.email}</span>
      <Link className="identity-link" to="/account/security">
        Security
      </Link>
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          localStorage.removeItem("reading-lite.bearerToken");
          queryClient.setQueryData(["whoami"], null);
          queryClient.removeQueries({ queryKey: ["readings"] });
          queryClient.removeQueries({ queryKey: ["reading"] });
          queryClient.removeQueries({ queryKey: ["reading-diagnostics"] });
          try {
            await logoutSession();
          } catch {
            // 401 or other failure: client identity and caches already dropped.
          } finally {
            onSignedOut();
            setBusy(false);
          }
        }}
        disabled={busy}
      >
        Log out
      </button>
    </div>
  );
}

function formatSessionTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function AccountSecurityPage({ onSignedOut }: { onSignedOut: () => void }) {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery({ queryKey: ["sessions"], queryFn: listSessions });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function dropIdentity() {
    localStorage.removeItem("reading-lite.bearerToken");
    queryClient.setQueryData(["whoami"], null);
    queryClient.removeQueries({ queryKey: ["readings"] });
    queryClient.removeQueries({ queryKey: ["reading"] });
    queryClient.removeQueries({ queryKey: ["reading-diagnostics"] });
    queryClient.removeQueries({ queryKey: ["sessions"] });
    onSignedOut();
  }

  async function onRevoke(session: SessionListItem) {
    if (busyId) return;
    setError(null);
    setBusyId(session.id);
    try {
      await revokeSession(session.id);
      if (session.current) {
        await dropIdentity();
        return;
      }
      await sessionsQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to revoke session");
    } finally {
      setBusyId(null);
    }
  }

  async function onRevokeAll() {
    if (busyId) return;
    if (!window.confirm("Revoke all browser sessions? This signs you out everywhere.")) return;
    setError(null);
    setBusyId("all");
    try {
      await revokeAllSessions();
      await dropIdentity();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to revoke sessions");
      setBusyId(null);
    }
  }

  const listed = sessionsQuery.data;
  return (
    <section className="page account-security">
      <div className="page-heading">
        <h1>Security</h1>
        <button type="button" onClick={() => void onRevokeAll()} disabled={busyId != null}>
          Revoke all sessions
        </button>
      </div>
      {listed?.session_cap_warning ? (
        <p className="session-cap-warning" role="status">
          {listed.session_cap_warning}
        </p>
      ) : null}
      {error ? <p className="error-message">{error}</p> : null}
      {sessionsQuery.isPending ? <StatusMessage>Loading</StatusMessage> : null}
      {sessionsQuery.isError ? (
        <IdentityError
          error={sessionsQuery.error instanceof Error ? sessionsQuery.error : new Error("failed to list sessions")}
          onRetry={() => void sessionsQuery.refetch()}
        />
      ) : null}
      {listed ? (
        <ul className="session-list">
          {listed.sessions.map((session) => (
            <li key={session.id} className={session.revoked_at_ms ? "session-revoked" : undefined}>
              <div>
                <p>
                  {session.user_agent_label ?? "Unknown browser"}
                  {session.current ? " (this device)" : ""}
                  {session.revoked_at_ms ? ` · revoked${session.revocation_reason ? ` (${session.revocation_reason})` : ""}` : ""}
                </p>
                <p className="session-meta">
                  Signed in {formatSessionTime(session.authenticated_at_ms)} · last seen{" "}
                  {formatSessionTime(session.last_seen_at_ms)}
                </p>
              </div>
              {session.revoked_at_ms ? null : (
                <button type="button" onClick={() => void onRevoke(session)} disabled={busyId != null}>
                  {session.current ? "Revoke this device" : "Revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function LoginPage({
  identity,
  identityQuery
}: {
  identity: WhoamiResponse | null;
  identityQuery: ReturnType<typeof useIdentity>;
}) {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = searchParams.get("next");

  useLayoutEffect(() => {
    if (identity) return;
    rememberLoginReturnPath(next);
  }, [identity, next]);

  if (identity) {
    const dest = safeReadingReturnPath(next) ?? "/";
    return <Navigate to={dest} replace />;
  }
  if (identityQuery.isPending || identityQuery.isFetching) return <StatusMessage>Loading</StatusMessage>;
  if (identityQuery.isError) {
    return (
      <IdentityError error={identityError(identityQuery.error)} onRetry={() => void identityQuery.refetch()} />
    );
  }
  return (
    <section className="page">
      <div className="page-heading">
        <h1>Sign in</h1>
      </div>
      <form
        className="token-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            await requestLoginLink(email);
            setSubmitted(true);
          } catch (e) {
            setError(e instanceof Error ? e.message : "failed to request sign-in link");
          }
        }}
      >
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <button type="submit">Email me a link</button>
      </form>
      {submitted ? (
        <p role="status">If that address can sign in, we sent a short-lived link.</p>
      ) : null}
      {error ? (
        <p className="submit-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function VerifyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState(() => captureMagicLinkCredential(location.hash));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redemptionId = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `clm_${crypto.randomUUID()}`
      : `clm_${Math.random().toString(36).slice(2)}`
  );

  useEffect(() => {
    const hash = location.hash || (typeof window !== "undefined" ? window.location.hash : "");
    const next = captureMagicLinkCredential(hash);
    if (next !== "" && next !== credential) setCredential(next);
    if (hash.replace(/^#/, "") === "") return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    navigate(`${location.pathname}${location.search}` || "/auth/verify", { replace: true });
  }, [credential, location.hash, location.pathname, location.search, navigate]);

  return (
    <section className="page">
      <div className="page-heading">
        <h1>Complete sign-in</h1>
      </div>
      {credential === "" ? (
        <p>This sign-in link is missing its secret. Request a new link.</p>
      ) : (
        <>
          <p>Confirm to finish signing in. This does nothing until you continue.</p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await redeemLoginLink(credential, redemptionId.current);
                clearMagicLinkCredential();
                await queryClient.cancelQueries({ queryKey: ["whoami"] });
                await queryClient.resetQueries({ queryKey: ["whoami"] });
                const whoami = await queryClient.fetchQuery({ queryKey: ["whoami"] });
                if (!whoami) throw new Error("failed to complete sign-in");
                navigate(consumeLoginReturnPath(searchParams.get("next")), { replace: true });
              } catch (e) {
                setError(e instanceof Error ? e.message : "failed to complete sign-in");
              } finally {
                setBusy(false);
              }
            }}
          >
            Continue
          </button>
        </>
      )}
      {error ? (
        <p className="submit-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ReadingList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const tag = searchParams.get("tag") ?? "";
  const offset = parseOffset(searchParams.get("offset"));
  const [draft, setDraft] = useState(q);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  const query = useQuery({
    queryKey: ["readings", q, tag, offset],
    queryFn: () => listReadings({ limit: pageSize, offset, q, tag })
  });

  const updateParams = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    setSearchParams(next);
  };

  return (
    <section className="page">
      <div className="page-heading">
        <h1>Reading Library</h1>
      </div>

      <SubmitForm />

      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          updateParams({ q: draft.trim(), offset: undefined });
        }}
      >
        <label htmlFor="reading-search">Search readings</label>
        <input
          id="reading-search"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="title, url, tldr, keywords"
        />
        <button type="submit">Search</button>
      </form>

      {tag !== "" ? (
        <div className="active-filters" aria-label="Active filters">
          <button
            type="button"
            className="active-tag"
            aria-label={`Clear tag ${tag}`}
            onClick={() => updateParams({ tag: undefined, offset: undefined })}
          >
            Tag: {tag} ×
          </button>
        </div>
      ) : null}

      {query.isLoading ? <StatusMessage>Loading readings</StatusMessage> : null}
      {query.isError ? <ErrorState error={query.error} /> : null}
      {query.isSuccess && query.data.readings.length === 0 ? (
        <StatusMessage>{emptyMessage(q, tag)}</StatusMessage>
      ) : null}
      {query.isSuccess && query.data.readings.length > 0 ? (
        <>
          <div className="reading-list">
            {query.data.readings.map((reading) => (
              <ReadingListItem
                key={reading.id}
                reading={reading}
                onSelectTag={(selected) => updateParams({ tag: selected, offset: undefined })}
              />
            ))}
          </div>
          <div className="pager">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => updateParams({ offset: nextOffsetParam(offset - pageSize) })}
            >
              Previous
            </button>
            <span>Page {Math.floor(offset / pageSize) + 1}</span>
            <button
              type="button"
              disabled={!query.data.has_more}
              onClick={() => updateParams({ offset: nextOffsetParam(offset + pageSize) })}
            >
              Next
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function SubmitForm() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="submit-form search-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const url = draft.trim();
        if (url === "") return;
        setSubmitting(true);
        setError(null);
        try {
          await submitReading(url);
          setDraft("");
          await queryClient.invalidateQueries({ queryKey: ["readings"] });
        } catch (e) {
          setError(e instanceof Error ? e.message : "submit failed");
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <label htmlFor="submit-url">Submit a URL</label>
      <input
        id="submit-url"
        type="url"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="https://example.com/article"
      />
      <button type="submit" disabled={submitting || draft.trim() === ""}>
        Submit
      </button>
      {error !== null ? (
        <span className="submit-error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

function parseOffset(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Snap to a pageSize boundary so the "Page N" label always matches the
  // served slice (a hand-typed ?offset=15 would otherwise show "Page 1" while
  // serving items 15–34).
  return Math.floor(n / pageSize) * pageSize;
}

function nextOffsetParam(value: number): string | undefined {
  return value <= 0 ? undefined : String(value);
}

function emptyMessage(q: string, tag: string): string {
  if (q !== "" || tag !== "") {
    return "No readings match your filters";
  }
  return "No readings yet";
}

function ReadingListItem({
  reading,
  onSelectTag
}: {
  reading: ListReading;
  onSelectTag: (tag: string) => void;
}) {
  return (
    <article className="reading-row">
      <div className="reading-row-main">
        <Link to={`/readings/${reading.id}`}>{reading.title || reading.url}</Link>
        {reading.tldr ? <p>{reading.tldr}</p> : null}
        <StatusBadge
          status={reading.status}
          error={reading.error?.message}
          activeAttempt={reading.active_attempt}
          lastAttempt={reading.last_attempt}
        />
        <TagList tags={reading.tags ?? []} onSelect={onSelectTag} />
      </div>
      <div className="reading-row-meta">
        <span>{reading.novelty_verdict || "unclassified"}</span>
        <time dateTime={reading.created_at}>{formatDate(reading.created_at)}</time>
      </div>
    </article>
  );
}

function StatusBadge({
  status,
  error,
  activeAttempt,
  lastAttempt
}: {
  status: ManifestStatus;
  error?: string;
  activeAttempt?: ProcessingAttemptSummary;
  lastAttempt?: ProcessingAttemptSummary;
}) {
  if (activeAttempt?.status === "running" && activeAttempt.trigger === "reprocess") {
    return <span className="status-pill status-pending">Reprocessing...</span>;
  }
  if (status === "ready") {
    if (lastAttempt?.trigger === "reprocess" && lastAttempt.status === "failed") {
      return (
        <span className="status-pill status-failed">
          Reprocess failed: {lastAttempt.error?.message ?? "unknown"}
        </span>
      );
    }
    return null;
  }
  if (status === "pending") {
    return <span className="status-pill status-pending">Processing...</span>;
  }
  if (activeAttempt?.status === "running") {
    return <span className="status-pill status-pending">Processing...</span>;
  }
  return (
    <span className="status-pill status-failed">
      Failed: {error ?? "unknown"}
    </span>
  );
}

function ReadingDetail() {
  const { id } = useParams();
  const readingID = id ?? "";
  const queryClient = useQueryClient();
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const query = useQuery({
    queryKey: ["reading", readingID],
    queryFn: () => getReading(readingID),
    enabled: readingID !== ""
  });

  if (query.isLoading) {
    return <StatusMessage>Loading reading</StatusMessage>;
  }
  if (query.isError) {
    return <ErrorState error={query.error} />;
  }
  if (!query.data) {
    return <StatusMessage>Reading not found</StatusMessage>;
  }

  const reading = query.data;
  const active = reading.active_attempt?.status === "running";
  return (
    <section className="page detail-page">
      <Link className="back-link" to="/">
        Back to readings
      </Link>
      <div className="page-heading detail-heading">
        <div>
          <h1>{reading.title || reading.url}</h1>
          <a href={reading.url} rel="noreferrer" target="_blank">
            {reading.url}
          </a>
          <StatusBadge
            status={reading.status}
            error={reading.error?.message}
            activeAttempt={reading.active_attempt}
            lastAttempt={reading.last_attempt}
          />
        </div>
        <div className="detail-actions">
          <span className="verdict">{reading.novelty_verdict || "unclassified"}</span>
          <button
            type="button"
            disabled={active || reprocessing}
            onClick={async () => {
              setReprocessing(true);
              setReprocessError(null);
              try {
                await reprocessReading(reading.id);
                await queryClient.invalidateQueries({ queryKey: ["reading", reading.id] });
                await queryClient.invalidateQueries({ queryKey: ["reading-diagnostics", reading.id] });
                await queryClient.invalidateQueries({ queryKey: ["readings"] });
              } catch (e) {
                setReprocessError(e instanceof Error ? e.message : "reprocess failed");
              } finally {
                setReprocessing(false);
              }
            }}
          >
            {active || reprocessing ? "Reprocessing" : "Reprocess"}
          </button>
        </div>
      </div>
      {reprocessError !== null ? (
        <p className="content-error" role="alert">
          {reprocessError}
        </p>
      ) : null}
      {reading.tldr ? (
        <section className="detail-section">
          <h2>TL;DR</h2>
          <p>{reading.tldr}</p>
        </section>
      ) : null}
      {reading.summary_markdown ? (
        <section className="detail-section">
          <h2>Summary</h2>
          <ReactMarkdown>{reading.summary_markdown}</ReactMarkdown>
        </section>
      ) : null}
      <section className="detail-grid">
        <EntityGroup label="Tags" values={reading.tags ?? []} />
        <EntityGroup label="Keywords" values={reading.keywords ?? []} />
        <EntityGroup label="People" values={reading.people ?? []} />
        <EntityGroup label="Organizations" values={reading.orgs ?? []} />
      </section>
      <ConnectionsPanel connections={reading.connections ?? []} />
      <ContentLinks id={reading.id} />
      <DiagnosticsPanel id={reading.id} />
    </section>
  );
}

function ConnectionsPanel({ connections }: { connections: Connection[] }) {
  return (
    <section className="detail-section connections-panel">
      <h2>Connections</h2>
      {connections.length === 0 ? (
        <p className="empty-state">No connections</p>
      ) : (
        <ul className="connections">
          {connections.map((c) => (
            <li key={c.id}>
              <Link to={`/readings/${c.id}`}>{c.id}</Link>
              <span className="connection-reason"> — {c.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ContentLinks({ id }: { id: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (kind: ContentKind) => {
    setError(null);
    try {
      const blob = await fetchContentBlob(id, kind);
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, "_blank", "noopener");
      // Browser-routes need the URL alive long enough for the new tab to load
      // and start streaming; revoke on a coarse delay rather than immediately.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to fetch content");
    }
  };
  return (
    <section className="detail-section content-links">
      <h2>Content</h2>
      <ul className="task-links">
        <li>
          <button type="button" className="link-button" onClick={() => open("content")}>
            Extracted markdown
          </button>
        </li>
        <li>
          <button type="button" className="link-button" onClick={() => open("content/raw")}>
            Raw bytes
          </button>
        </li>
      </ul>
      {error !== null ? (
        <p className="content-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function DiagnosticsPanel({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ["reading-diagnostics", id],
    queryFn: () => getReadingDiagnostics(id)
  });

  if (query.isLoading) {
    return (
      <section className="detail-section diagnostics-panel">
        <h2>Diagnostics</h2>
        <p>Loading diagnostics</p>
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className="detail-section diagnostics-panel">
        <h2>Diagnostics</h2>
        <p className="content-error">Diagnostics unavailable</p>
      </section>
    );
  }
  if (!query.data) {
    return null;
  }

  const diagnostics = query.data;
  const attempts = diagnostics.attempts ?? [];
  const objects = diagnostics.objects ?? [];
  const byId = diagnostics.pointers?.by_id;
  const byUrl = diagnostics.pointers?.by_url;
  const latest = attempts[0];
  return (
    <section className="detail-section diagnostics-panel">
      <h2>Diagnostics</h2>
      <div className="diagnostics-grid">
        <DiagnosticFact label="Status" value={diagnostics.manifest?.status ?? "unknown"} />
        <DiagnosticFact label="Key" value={diagnostics.key_prefix ?? ""} />
        <DiagnosticFact
          label="By ID"
          value={byId?.matches_manifest ? "ok" : "mismatch"}
        />
        <DiagnosticFact
          label="By URL"
          value={
            byUrl?.exists
              ? byUrl.matches_manifest
                ? "ok"
                : "mismatch"
              : "missing"
          }
        />
        <DiagnosticFact label="Objects" value={String(objects.length)} />
        <DiagnosticFact label="Attempts" value={String(attempts.length)} />
      </div>
      {latest ? <AttemptBlock attempt={latest} /> : <p className="empty-state">No attempts</p>}
    </section>
  );
}

function DiagnosticFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="diagnostic-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AttemptBlock({ attempt }: { attempt: ProcessingAttempt }) {
  return (
    <div className="attempt-block">
      <div className="attempt-heading">
        <strong>{attempt.trigger}</strong>
        <span>{attempt.status}</span>
        {attempt.stage ? <span>{stageLabel(attempt.stage)}</span> : null}
        <time dateTime={attempt.started_at}>{formatDateTime(attempt.started_at)}</time>
      </div>
      {attempt.error ? (
        <p className="attempt-error">
          {stageLabel(attempt.error.stage ?? attempt.stage ?? "queued")}: {attempt.error.message}
        </p>
      ) : null}
      <ol className="attempt-events">
        {attempt.events.map((event, index) => (
          <li key={`${event.stage}-${event.status}-${index}`}>
            <span>{stageLabel(event.stage)}</span>
            <span>{event.status}</span>
            {event.duration_ms !== undefined ? <span>{event.duration_ms}ms</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function EntityGroup({ label, values }: { label: string; values: string[] }) {
  return (
    <section className="entity-group">
      <h2>{label}</h2>
      {values.length > 0 ? <TagList tags={values} /> : <p>None</p>}
    </section>
  );
}

function TagList({ tags, onSelect }: { tags: string[]; onSelect?: (tag: string) => void }) {
  if (tags.length === 0) {
    return null;
  }
  return (
    <div className="tags">
      {tags.map((tag) =>
        onSelect ? (
          <button
            key={tag}
            type="button"
            className="tag-chip"
            aria-label={`Filter by tag ${tag}`}
            onClick={() => onSelect(tag)}
          >
            {tag}
          </button>
        ) : (
          <span key={tag}>{tag}</span>
        )
      )}
    </div>
  );
}

function StatusMessage({ children }: { children: ReactNode }) {
  return <div className="status-message">{children}</div>;
}

function ErrorState({ error }: { error: Error }) {
  const queryClient = useQueryClient();
  const isAuthFailure = error instanceof ApiError && (error.status === 401 || error.status === 403);

  useEffect(() => {
    if (!isAuthFailure) return;
    void queryClient.invalidateQueries({ queryKey: ["whoami"] });
  }, [isAuthFailure, queryClient]);

  const message = isAuthFailure ? "Sign in to continue." : "Could not load readings.";
  return <div className="error-message">{message}</div>;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function stageLabel(value: string) {
  return value.replace(/_/g, " ");
}

export default App;
