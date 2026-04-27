import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  BrowserRouter,
  Link,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useParams,
  useSearchParams
} from "react-router-dom";

import {
  ApiError,
  fetchContentBlob,
  getReading,
  listReadings,
  submitReading,
  tokenStorageKey,
  type ContentKind
} from "./api";
import type { Connection, ListReading, ManifestStatus } from "./types";
import "./styles.css";

type AppProps = {
  initialPath?: string;
};

const pageSize = 20;

export function App({ initialPath }: AppProps) {
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
  const [token, setToken] = usePersistentToken();
  const router = initialPath ? (
    <MemoryRouter initialEntries={[initialPath]}>
      <AppRoutes token={token} setToken={setToken} />
    </MemoryRouter>
  ) : (
    <BrowserRouter>
      <AppRoutes token={token} setToken={setToken} />
    </BrowserRouter>
  );

  return <QueryClientProvider client={queryClient}>{router}</QueryClientProvider>;
}

function usePersistentToken(): [string, (token: string) => void] {
  const [token, setTokenState] = useState(() => window.localStorage.getItem(tokenStorageKey) ?? "");
  const setToken = (nextToken: string) => {
    const trimmed = nextToken.trim();
    setTokenState(trimmed);
    if (trimmed === "") {
      window.localStorage.removeItem(tokenStorageKey);
    } else {
      window.localStorage.setItem(tokenStorageKey, trimmed);
    }
  };
  return [token, setToken];
}

function AppRoutes({ token, setToken }: { token: string; setToken: (token: string) => void }) {
  return (
    <Shell token={token} setToken={setToken}>
      <Routes>
        <Route path="/" element={<ReadingList token={token} />} />
        <Route path="/readings/:id" element={<ReadingDetail token={token} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({
  children,
  token,
  setToken
}: {
  children: ReactNode;
  token: string;
  setToken: (token: string) => void;
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
          <AuthTokenForm token={token} setToken={setToken} />
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}

function AuthTokenForm({ token, setToken }: { token: string; setToken: (token: string) => void }) {
  const [draft, setDraft] = useState(token);

  return (
    <form
      className="token-form"
      onSubmit={(event) => {
        event.preventDefault();
        setToken(draft);
      }}
    >
      <label htmlFor="bearer-token">Bearer token</label>
      <input
        id="bearer-token"
        type="password"
        autoComplete="off"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit">Save</button>
    </form>
  );
}

function ReadingList({ token }: { token: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const tag = searchParams.get("tag") ?? "";
  const offset = parseOffset(searchParams.get("offset"));
  const [draft, setDraft] = useState(q);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  const query = useQuery({
    queryKey: ["readings", token, q, tag, offset],
    queryFn: () => listReadings(token, { limit: pageSize, offset, q, tag })
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

      <SubmitForm token={token} />

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
          placeholder="title, url, tldr"
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

function SubmitForm({ token }: { token: string }) {
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
          await submitReading(token, url);
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
        <StatusBadge status={reading.status} error={reading.error?.message} />
        <TagList tags={reading.tags ?? []} onSelect={onSelectTag} />
      </div>
      <div className="reading-row-meta">
        <span>{reading.novelty_verdict || "unclassified"}</span>
        <time dateTime={reading.created_at}>{formatDate(reading.created_at)}</time>
      </div>
    </article>
  );
}

function StatusBadge({ status, error }: { status: ManifestStatus; error?: string }) {
  if (status === "ready") return null;
  if (status === "pending") {
    return <span className="status-pill status-pending">Processing…</span>;
  }
  return (
    <span className="status-pill status-failed">
      Failed: {error ?? "unknown"}
    </span>
  );
}

function ReadingDetail({ token }: { token: string }) {
  const { id } = useParams();
  const readingID = id ?? "";
  const query = useQuery({
    queryKey: ["reading", token, readingID],
    queryFn: () => getReading(token, readingID),
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
          <StatusBadge status={reading.status} error={reading.error?.message} />
        </div>
        <span className="verdict">{reading.novelty_verdict || "unclassified"}</span>
      </div>
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
      <ContentLinks id={reading.id} token={token} />
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

function ContentLinks({ id, token }: { id: string; token: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (kind: ContentKind) => {
    setError(null);
    try {
      const blob = await fetchContentBlob(token, id, kind);
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
  const message =
    error instanceof ApiError && (error.status === 401 || error.status === 403)
      ? "Authentication failed. Check your bearer token."
      : "Could not load readings.";
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

export default App;
