/** Shared prototype simulation with comparison and dedicated Connected entrypoints. */
import { useEffect, useRef, useState } from "react";
import { directions, readings, type Reading } from "./samples";
import { Icon, parseRoute, routeHash, parseConnectedRoute, connectedRouteHash, StudyContext, type Filters, type Outcome, type ProviderState, type Route, type Study, type View } from "./study";
import { Capture, Library, Provider, ReadingDetail, Review, StatusView } from "./screens";

export function App({ mode = "comparison" }: { mode?: "comparison" | "connected" } = {}) {
  const connectedOnly = mode === "connected";
  const readRoute = () => connectedOnly ? parseConnectedRoute(window.location.hash) : parseRoute(window.location.hash);
  const hashFor = (next: Route) => connectedOnly ? connectedRouteHash(next) : routeHash(next);
  const [route, setRoute] = useState(readRoute);
  const [items, setItems] = useState<Reading[]>(() => readings.map(r => ({ ...r })).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)));
  const [filters, setFilters] = useState<Filters>({ query: "", tag: "All", page: 1 });
  const [sparse, setSparse] = useState(false);
  const [scenario, setScenario] = useState("normal");
  const [theme, setTheme] = useState("light");
  const [device, setDevice] = useState("desktop");
  const [tabs, setTabs] = useState<Record<string, "summary" | "source">>({});
  const [captureMode, setCaptureMode] = useState<"url" | "markdown">("url");
  const [outcome, setOutcome] = useState<Outcome>("ready");
  const [jobOutcomes, setJobOutcomes] = useState<Record<string, Outcome>>({ pending: "ready", failed: "source" });
  const [provider, setProvider] = useState<ProviderState>("missing");
  const [providerMessage, setProviderMessage] = useState("");
  const captureSequence = useRef(0);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const update = () => {
      const next = readRoute();
      setRoute(next);
      if (connectedOnly && window.location.hash !== hashFor(next)) window.history.replaceState(null, "", hashFor(next));
    };
    window.addEventListener("hashchange", update);
    if (connectedOnly || !window.location.hash) window.history.replaceState(null, "", hashFor(route));
    return () => window.removeEventListener("hashchange", update);
  }, [connectedOnly]);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    document.querySelector(connectedOnly ? ".connected-prototype" : ".study-bar")?.scrollIntoView?.({ block: "start" });
    const direction = directions.find(d => d.id === route.direction)!;
    document.title = `${connectedOnly ? "" : `${direction.name} · `}${route.view === "reading" ? items.find(r => r.id === route.id)?.title ?? "Unavailable reading" : route.view[0].toUpperCase() + route.view.slice(1)} · Reading Lite`;
  }, [route.direction, route.view, route.id]);

  function navigate(next: Route) {
    const destination: Route = connectedOnly ? { ...next, direction: "connected", view: next.view === "review" ? "library" : next.view } : next;
    setRoute(destination); window.location.hash = hashFor(destination);
  }
  function go(view: View, id = "attention", trail: string[] = []) { navigate({ direction: route.direction, view, id, trail }); }
  function setTab(id: string, tab: "summary" | "source") { setTabs(previous => ({ ...previous, [id]: tab })); }
  function retry(id: string) {
    setItems(previous => previous.map(r => r.id === id ? { ...r, status: "pending" } : r));
    setJobOutcomes(previous => ({ ...previous, [id]: "ready" }));
    go("status", id);
  }
  function capture(url: string, markdown: string) {
    if (captureMode === "url") {
      try { if (!["http:", "https:"].includes(new URL(url).protocol)) return "Use a complete http or https URL."; }
      catch { return "Use a complete http or https URL."; }
    } else if (!markdown.trim()) return "Paste some Markdown to import.";
    const template = readings.find(r => r.id === "pending")!;
    const id = `capture-${++captureSequence.current}`;
    const next: Reading = { ...template, id, status: "pending" };
    if (captureMode === "markdown") {
      next.title = markdown.match(/^#\s+(.+)$/m)?.[1] || "Your Markdown reading";
      next.publication = "Markdown import"; next.author = "Your imported text";
      next.summary = "Your Markdown is available in the Source tab. This preview does not generate a summary or compare your text with the archive.";
      next.points = ["The original text stays available to read.", "A connected AI provider would prepare the summary and comparisons in the finished product."];
      next.novelty = "Not assessed in this preview. Use the authored sample readings to compare novelty and connection designs.";
      next.connections = [];
      next.source = [{ heading: "Imported Markdown", text: markdown.replace(/^#\s+.+\n?/, "").trim() || markdown }];
    }
    setItems(previous => [next, ...previous]);
    setJobOutcomes(previous => ({ ...previous, [id]: outcome }));
    setSparse(false); go("status", id); return null;
  }
  function chooseScenario(value: string) {
    setScenario(value); setSparse(value === "sparse"); setFilters({ query: "", tag: "All", page: 1 });
    if (value === "sparse") go("library");
    else if (value === "source") { setTab("unavailable", "source"); go("reading", "unavailable"); }
    else if (value === "long") go("reading", "long-title");
    else if (value === "pending" || value === "failed") {
      setItems(previous => previous.map(r => r.id === value ? { ...r, status: value } : r));
      setJobOutcomes(previous => ({ ...previous, [value]: value === "pending" ? "ready" : "source" }));
      go("status", value);
    } else go("reading", "attention");
  }
  const study: Study = {
    route, go, items, visibleItems: sparse ? items.filter(r => r.id === "attention") : items, sparse,
    filters, setFilters, tabs, setTab, captureMode, setCaptureMode, outcome, setOutcome, capture, jobOutcomes, retry,
    follow: id => go("reading", id, [...route.trail, route.id]),
    back: () => go("reading", route.trail.at(-1) || "attention", route.trail.slice(0, -1)),
    checkStatus: id => setItems(previous => previous.map(r => r.id === id ? { ...r, status: (jobOutcomes[id] || "ready") === "ready" ? "ready" : "failed" } : r)),
    provider, setProvider, providerMessage, setProviderMessage,
  };
  const current = items.find(r => r.id === route.id);
  const isReading = route.view === "reading" || route.view === "status";
  const direction = directions.find(d => d.id === route.direction)!;
  function navButton(view: View, label: string, icon: string, primary = false) {
    return <button aria-label={label} className={`${route.view === view ? "nav-active" : ""} ${primary ? "primary" : ""}`} onClick={() => go(view)}><Icon name={icon}/><span>{label}</span></button>;
  }
  const navigation = <>{navButton("library", "Library", "library")}{navButton("capture", "Save reading", "plus", route.direction !== "connected")}{navButton("provider", "Provider", "settings")}</>;

  return <StudyContext.Provider value={study}><div className={connectedOnly ? "connected-prototype" : undefined} data-theme={theme}>
    {!connectedOnly && <header className="study-bar">
      <div className="study-name">READING LITE<span>Interface directions / 01</span></div>
      <nav className="direction-picker" aria-label="Design directions">{directions.map(d => <button key={d.id} aria-label={`Compare ${d.name}`} aria-pressed={route.direction === d.id} className={route.direction === d.id ? "selected" : ""} onClick={() => navigate({ ...route, direction: d.id, view: route.view === "review" ? (d.id === "workbench" ? "library" : "reading") : route.view })}>{d.letter}<span>{d.short}</span></button>)}</nav>
      <button className="review-button" onClick={() => go("review")}>Review & choose <Icon name="arrow" size={16}/></button>
    </header>}
    <div className="study-controls"><div><span className="sample-dot"/>{connectedOnly ? "Prototype" : "Authored samples"} <span className="control-note">· No live requests</span></div><div className="scenario-control"><label htmlFor="scenario">Sample scenario</label><select id="scenario" value={scenario} onChange={e => chooseScenario(e.target.value)}><option value="normal">Full library</option><option value="long">Long title</option><option value="sparse">Sparse archive</option><option value="source">Unavailable source</option><option value="deleted">Deleted connection</option><option value="pending">Pending capture</option><option value="failed">Failed capture</option></select></div><div className="preview-toggles"><div className="toggle-pair"><button aria-label="Desktop layout" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}><Icon name="desktop"/></button><button aria-label="Phone layout" aria-pressed={device === "phone"} onClick={() => setDevice("phone")}><Icon name="phone"/></button></div><div className="toggle-pair"><button aria-label="Light theme" aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Icon name="sun"/></button><button aria-label="Dark theme" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Icon name="moon"/></button></div></div></div>
    <div className={`stage ${device}`} data-testid="prototype-stage"><div className="prototype" data-theme={theme} data-direction={route.direction} data-testid="prototype-surface"><div className={`app ${route.direction}`}>
      {route.direction === "editorial" ? <header className="product-header"><a className="brand" href="#/editorial/reading/attention"><span className="brand-mark">r.</span>reading lite</a><nav aria-label="Reading Lite">{navigation}</nav></header> : <aside className="app-sidebar"><a className="brand" href={connectedOnly ? "#/library" : `#/${route.direction}/reading/attention`} aria-label="Reading Lite home"><span className="brand-mark">r.</span><span>reading lite</span></a><nav aria-label="Reading Lite">{navigation}</nav><div className="sidebar-bottom"><span className="avatar">B</span><span>Brian’s library<small>Sample workspace</small></span></div></aside>}
      <main className="app-main" ref={main} tabIndex={-1} aria-label={direction.name}>
        {route.direction === "workbench" && <div className="workspace-header"><span>PERSONAL LIBRARY</span><span className="workspace-date">Monday, September 7</span></div>}
        {route.view === "library" && <Library/>}{route.view === "capture" && <Capture/>}{route.view === "provider" && <Provider/>}{route.view === "review" && <Review/>}
        {isReading && (route.view === "status" || current?.status === "pending" || current?.status === "failed" ? <StatusView reading={current}/> : <ReadingDetail reading={current}/>)}
      </main>
    </div></div></div>
    {!connectedOnly && <footer className="study-footer"><span>{direction.letter} / {direction.name}</span>{route.direction !== "connected" && <span>Same readings. Three ways to spend time with them.</span>}<button onClick={() => go("review")}>Compare the tasks <Icon name="arrow" size={14}/></button></footer>}
  </div></StudyContext.Provider>;
}
