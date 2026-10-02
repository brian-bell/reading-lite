/** The prototype: one shell, the scenario and preview controls, and the simulation state every screen reads. */
import { useEffect, useRef, useState } from "react";
import { Icon, StudyContext, type Study } from "./context";
import { STUDY_NOW, inboxItems as authoredInbox, readings as authored, type InboxItem, type Reading } from "./samples";
import { DeskPage, DigestPage, Landing } from "./screens/Desk";
import { CatalogPage } from "./screens/Catalog";
import { LibraryPage } from "./screens/Library";
import { ReadingPage } from "./screens/Reading";
import { ThreadPage, ThreadsPage } from "./screens/Threads";
import { ProviderPage, SavePage, Shell, type NavSpec } from "./shared";
import {
  DEFAULT_LAST_VISIT,
  FAILURE_FOR,
  HOME_VIEW,
  SAMPLE_IDS,
  SCENARIOS,
  SCENARIO_READING,
  annotateStale,
  parseRoute,
  readingsForScenario,
  routeHash,
  type Outcome,
  type ProviderState,
  type Route,
  type Scenario,
  type View,
} from "./study";

const NAV: NavSpec[] = [
  { view: "desk", label: "Desk", icon: "desk", matches: ["digest", "landing"] },
  { view: "library", label: "Library", icon: "library", matches: ["reading"] },
  { view: "threads", label: "Threads", icon: "thread", matches: ["thread"] },
  { view: "catalog", label: "Catalog", icon: "index" },
  { view: "save", label: "Save reading", icon: "plus" },
];

const VIEW_TITLES: Partial<Record<View, string>> = {
  desk: "Desk",
  library: "Library",
  threads: "Threads",
  thread: "Thread",
  catalog: "Catalog",
  save: "Save reading",
  provider: "Account",
  digest: "Digest preview",
  landing: "Reading Lite",
};

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [scenario, setScenario] = useState<Scenario>("full");
  const [items, setItems] = useState<Reading[]>(() => readingsForScenario("full"));
  const [inbox, setInbox] = useState<InboxItem[]>(() => authoredInbox.map((item) => ({ ...item })));
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [tabs, setTabs] = useState<Record<string, "summary" | "source">>({});
  const [captureMode, setCaptureMode] = useState<"url" | "markdown">("url");
  const [outcome, setOutcome] = useState<Outcome>("ready");
  const [jobOutcomes, setJobOutcomes] = useState<Record<string, Outcome>>({ "why-we-skim": "ready" });
  const [provider, setProvider] = useState<ProviderState>("connected");
  const [signedIn, setSignedIn] = useState(true);
  const [deskIds, setDeskIds] = useState<string[]>(["the-tab-that-never-closes", "a-quieter-internet"]);
  const [sampleStep, setSampleStep] = useState(0);
  const captureSequence = useRef(0);
  // Every screen reads the rows as the backend serves them: a pending reading
  // past the window is already failed here, while `items` keeps the stored row.
  const visible = items.map((reading) => annotateStale(reading, STUDY_NOW));

  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    if (!window.location.hash) window.history.replaceState(null, "", routeHash(route));
    return () => window.removeEventListener("hashchange", update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
    document.querySelector(".stage")?.scrollIntoView?.({ block: "start" });
    const current = route.view === "reading"
      ? (visible.find((r) => r.id === route.id)?.title ?? authored.find((r) => r.id === route.id)?.title ?? "Unavailable reading")
      : (VIEW_TITLES[route.view] ?? route.view);
    document.title = `${current} · Reading Lite`;
  }, [route.view, route.id]);

  /** Flip the theme with every transition suppressed for the frame it lands on, so the swap snaps instead of smearing. */
  function chooseTheme(next: "light" | "dark") {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.appendChild(style);
    setTheme(next);
    requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
  }
  function navigate(next: Route) {
    setRoute(next);
    window.location.hash = routeHash(next);
  }
  function routeFor(view: View, id = "", extra: Partial<Route> = {}): Route {
    // Only the parameters named in `extra` carry over; a plain navigation starts clean.
    return { view, id, trail: extra.trail ?? [], q: extra.q ?? "", tag: extra.tag ?? "", facet: extra.facet ?? "", mode: extra.mode ?? "" };
  }
  function go(view: View, id = "", extra: Partial<Route> = {}) {
    navigate(routeFor(view, id, extra));
  }
  function hrefFor(view: View, id = "", extra: Partial<Route> = {}) {
    return routeHash(routeFor(view, id, extra));
  }
  function lookup(id: string) {
    const own = visible.find((r) => r.id === id);
    if (own) return { reading: own, sample: false };
    const sample = SAMPLE_IDS.includes(id) ? authored.find((r) => r.id === id) : undefined;
    return sample ? { reading: sample, sample: true } : undefined;
  }
  function setTab(id: string, tab: "summary" | "source") {
    setTabs((previous) => ({ ...previous, [id]: tab }));
  }
  function retry(id: string) {
    setItems((previous) => previous.map((r) => r.id === id ? { ...r, status: "pending", stage: "queued", attemptStartedAt: STUDY_NOW, error: undefined } : r));
    setJobOutcomes((previous) => ({ ...previous, [id]: "ready" }));
    go("reading", id);
  }
  function checkStatus(id: string) {
    const result = jobOutcomes[id] ?? outcome;
    setItems((previous) => previous.map((r) => {
      if (r.id !== id) return r;
      if (result === "ready") {
        const template = authored.find((a) => a.id === "a-quieter-internet")!;
        return {
          ...r,
          status: "ready",
          stage: undefined,
          attemptStartedAt: undefined,
          error: undefined,
          lastAttempt: undefined,
          tldr: r.tldr ?? "A short argument that the shape of a reading tool decides whether its readers skim or stay, with three design rules drawn from print.",
          summary: r.summary ?? ["Skimming is a reasonable response to pages that promise more than they deliver. The essay proposes letting a page's shape tell the reader what kind of attention it wants.", "Three rules follow: show the length, show the structure, and let the reader stop without losing their place."],
          tags: r.tags.length ? r.tags : ["attention", "design"],
          keywords: r.keywords.length ? r.keywords : ["skimming", "page design", "attention"],
          people: r.people.length ? r.people : ["Mara Ellis"],
          orgs: r.orgs.length ? r.orgs : ["Fieldnotes"],
          novelty: r.novelty ?? "familiar",
          similarityCount: r.similarityCount ?? 2,
          connections: r.connections.length ? r.connections : [{ id: template.id, reason: "Both argue that a reading tool's shape decides how it is read; this piece adds page-level rules." }],
          source: r.source ?? [{ text: "Readers skim because pages give them no reason not to. A page that shows its length and its structure asks for a different kind of attention, and usually gets it." }],
        };
      }
      // A reading that had material before this attempt keeps it (the writer
      // rolls forward): ready, with the failure as its last attempt.
      if (r.tldr) {
        return { ...r, status: "ready", stage: undefined, attemptStartedAt: undefined, lastAttempt: { trigger: "reprocess", status: "failed", finishedAt: STUDY_NOW, error: FAILURE_FOR[result] } };
      }
      return { ...r, status: "failed", stage: undefined, attemptStartedAt: undefined, error: FAILURE_FOR[result] };
    }));
  }
  function capture(url: string, markdown: string): string | null {
    if (provider !== "connected") return "Connect your OpenAI key first.";
    if (captureMode === "url") {
      try {
        if (!["http:", "https:"].includes(new URL(url).protocol)) return "Use a complete http or https URL.";
      } catch {
        return "Use a complete http or https URL.";
      }
      const existing = items.find((r) => r.url === url);
      if (existing) {
        go("reading", existing.id);
        return null;
      }
    } else if (!markdown.trim()) {
      return "Paste some Markdown to import.";
    }
    const id = `capture-${++captureSequence.current}`;
    const title = captureMode === "markdown" ? (markdown.match(/^#\s+(.+)$/m)?.[1] || "Imported Markdown") : titleFromUrl(url);
    const next: Reading = {
      id,
      url: url || `https://notes.example/${id}`,
      title,
      status: "pending",
      createdAt: "2026-10-01T10:00:00Z",
      sourceType: captureMode,
      tags: [],
      keywords: [],
      people: [],
      orgs: [],
      connections: [],
      tensions: [],
      source: captureMode === "markdown" ? [{ text: markdown.replace(/^#\s+.+\n?/, "").trim() || markdown }] : null,
      stage: "queued",
    };
    setItems((previous) => [next, ...previous]);
    setJobOutcomes((previous) => ({ ...previous, [id]: outcome }));
    go("reading", id);
    return null;
  }
  function chooseScenario(value: Scenario) {
    setScenario(value);
    setItems(readingsForScenario(value));
    setInbox(value === "new-reader" || value === "sparse" ? [] : authoredInbox.map((item) => ({ ...item })));
    setProvider(value === "new-reader" ? "missing" : "connected");
    setSignedIn(value !== "new-reader");
    setDeskIds(value === "new-reader" || value === "sparse" ? [] : ["the-tab-that-never-closes", "a-quieter-internet"]);
    setSampleStep(0);
    const opens = SCENARIO_READING[value];
    if (value === "new-reader") go("landing");
    else if (opens) go("reading", opens);
    else go(HOME_VIEW);
  }
  function promote(id: string) {
    const item = inbox.find((i) => i.id === id);
    if (!item) return;
    setInbox((previous) => previous.filter((i) => i.id !== id));
    const readingId = `promoted-${id}`;
    const next: Reading = {
      id: readingId,
      url: item.url,
      title: item.title ?? item.url,
      status: "pending",
      createdAt: "2026-10-01T10:00:00Z",
      sourceType: "markdown",
      tags: [],
      keywords: [],
      people: [],
      orgs: [],
      connections: [],
      tensions: [],
      source: [{ text: item.markdown }],
      stage: "queued",
    };
    setItems((previous) => [next, ...previous]);
    setJobOutcomes((previous) => ({ ...previous, [readingId]: "ready" }));
    go("reading", readingId);
  }
  function discard(id: string) {
    setInbox((previous) => previous.filter((i) => i.id !== id));
  }
  function toggleDesk(id: string) {
    setDeskIds((previous) => previous.includes(id) ? previous.filter((d) => d !== id) : previous.length >= 3 ? previous : [...previous, id]);
  }
  function done(id: string) {
    const index = deskIds.indexOf(id);
    const next = deskIds[index + 1];
    setDeskIds((previous) => previous.filter((d) => d !== id));
    if (next) go("reading", next);
    else go("desk");
  }

  const study: Study = {
    route,
    go,
    hrefFor,
    lookup,
    follow: (id) => navigate({ ...routeFor("reading", id), trail: [...route.trail, route.id].slice(-10) }),
    back: () => navigate({ ...routeFor("reading", route.trail.at(-1) || ""), trail: route.trail.slice(0, -1) }),
    home: () => go(HOME_VIEW),
    items: visible,
    scenario,
    signedIn,
    signIn: () => { setSignedIn(true); go("desk"); },
    tabs,
    setTab,
    captureMode,
    setCaptureMode,
    outcome,
    setOutcome,
    capture,
    checkStatus,
    retry,
    provider,
    setProvider,
    inbox,
    promote,
    discard,
    deskIds,
    toggleDesk,
    done,
    lastVisit: DEFAULT_LAST_VISIT,
    sampleStep,
    setSampleStep,
  };
  const signedOut = scenario === "new-reader" && !signedIn;

  return (
    <StudyContext.Provider value={study}>
      <div className="study" data-theme={theme}>
        <header className="study-bar">
          <div className="study-name">READING LITE<span>Next direction / 02</span></div>
          <div className="study-controls">
            <div><span className="sample-dot" />Authored samples <span className="control-note">· No live requests</span></div>
            <div className="scenario-control">
              <label htmlFor="scenario">Scenario</label>
              <select id="scenario" value={scenario} onChange={(e) => chooseScenario(e.target.value as Scenario)}>
                {SCENARIOS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="preview-toggles">
              <div className="toggle-pair">
                <button type="button" aria-label="Desktop layout" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}><Icon name="desktop" /></button>
                <button type="button" aria-label="Phone layout" aria-pressed={device === "phone"} onClick={() => setDevice("phone")}><Icon name="phone" /></button>
              </div>
              <div className="toggle-pair">
                <button type="button" aria-label="Light theme" aria-pressed={theme === "light"} onClick={() => chooseTheme("light")}><Icon name="sun" /></button>
                <button type="button" aria-label="Dark theme" aria-pressed={theme === "dark"} onClick={() => chooseTheme("dark")}><Icon name="moon" /></button>
              </div>
            </div>
          </div>
        </header>
        <div className={`stage ${device}`} data-testid="prototype-stage">
          <div className="prototype" data-theme={theme} data-testid="prototype-surface">
            <Shell nav={NAV}>
              {route.view === "landing" && <Landing />}
              {route.view === "desk" && (signedOut ? <Landing /> : <DeskPage />)}
              {route.view === "digest" && <DigestPage />}
              {route.view === "library" && <LibraryPage />}
              {route.view === "reading" && <ReadingPage />}
              {route.view === "threads" && <ThreadsPage />}
              {route.view === "thread" && <ThreadPage />}
              {route.view === "catalog" && <CatalogPage />}
              {route.view === "save" && <SavePage />}
              {route.view === "provider" && <ProviderPage />}
            </Shell>
          </div>
        </div>
      </div>
    </StudyContext.Provider>
  );
}

function titleFromUrl(url: string): string {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    const words = slug.replace(/[-_]+/g, " ").replace(/\.[a-z]+$/, "").trim();
    return words ? words[0].toUpperCase() + words.slice(1) : new URL(url).hostname;
  } catch {
    return url;
  }
}
