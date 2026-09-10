/** Local simulation state only. Never connects to Reading Lite or an AI provider. */
import { createContext, useContext } from "react";
import { directions, type Direction, type Reading } from "./samples";

export type View = "reading" | "status" | "library" | "capture" | "provider" | "review";
export type Route = { direction: Direction; view: View; id: string; trail: string[] };
export type Outcome = "ready" | "source" | "credentials" | "provider" | "hosting";
export type ProviderState = "missing" | "connected" | "invalid" | "removed";
export type Filters = { query: string; tag: string; page: number };
export const pageSize = 5;

export function parseRoute(hash: string): Route {
  const [path, search] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const direction = directions.find(d => d.id === parts[0])?.id ?? "editorial";
  const views: string[] = ["reading", "status", "library", "capture", "provider", "review"];
  const view = views.includes(parts[1]) ? parts[1] as View : direction === "workbench" ? "library" : "reading";
  return { direction, view, id: parts[2] || "attention", trail: (new URLSearchParams(search).get("from") || "").split(",").filter(Boolean) };
}

export function routeHash(route: Route) {
  const path = `#/${route.direction}/${route.view}${route.view === "reading" || route.view === "status" ? `/${encodeURIComponent(route.id)}` : ""}`;
  return path + (route.trail.length ? `?from=${encodeURIComponent(route.trail.join(","))}` : "");
}

/** The dedicated entry accepts older comparison links but always stays Connected. */
export function parseConnectedRoute(hash: string): Route {
  const [path, search] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (directions.some(direction => direction.id === parts[0])) parts.shift();
  const views = ["reading", "status", "library", "capture", "provider"];
  const view = views.includes(parts[0]) ? parts[0] as View : "library";
  return {
    direction: "connected", view, id: parts[1] || "attention",
    trail: (new URLSearchParams(search).get("from") || "").split(",").filter(Boolean),
  };
}

export function connectedRouteHash(route: Route) {
  return routeHash({ ...route, direction: "connected", view: route.view === "review" ? "library" : route.view })
    .replace(/^#\/connected/, "#");
}

export function filterReadings(items: Reading[], filters: Filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter(item => (filters.tag === "All" || item.tags.includes(filters.tag)) &&
    [item.title, item.author, item.publication, item.summary, ...item.tags].join(" ").toLocaleLowerCase().includes(query));
}

export const failures: Record<Exclude<Outcome, "ready">, { title: string; message: string; action: string }> = {
  source: { title: "The source could not be captured", message: "The publisher blocked access to this article. Try again, or paste the article as Markdown if you have a copy.", action: "Import a copy" },
  credentials: { title: "Your AI key needs attention", message: "The provider rejected the sample key. Reconnect your key in provider settings, then retry this reading.", action: "Review provider settings" },
  provider: { title: "The AI provider is at its limit", message: "The provider asked us to wait. Your reading is saved. Check your provider's limits or try again later.", action: "Review provider settings" },
  hosting: { title: "Your reading allowance is used up", message: "New processing is paused at the hosting limit. Your existing library is still available. Try again when your allowance renews.", action: "Return to library" },
};

export type Study = {
  route: Route; go: (view: View, id?: string, trail?: string[]) => void;
  follow: (id: string) => void; back: () => void;
  items: Reading[]; visibleItems: Reading[]; sparse: boolean;
  filters: Filters; setFilters: (filters: Filters) => void;
  tabs: Record<string, "summary" | "source">; setTab: (id: string, tab: "summary" | "source") => void;
  captureMode: "url" | "markdown"; setCaptureMode: (mode: "url" | "markdown") => void;
  outcome: Outcome; setOutcome: (outcome: Outcome) => void;
  capture: (url: string, markdown: string) => string | null;
  jobOutcomes: Record<string, Outcome>; checkStatus: (id: string) => void; retry: (id: string) => void;
  provider: ProviderState; setProvider: (state: ProviderState) => void;
  providerMessage: string; setProviderMessage: (message: string) => void;
};
export const StudyContext = createContext<Study | null>(null);
export function useStudy() { const study = useContext(StudyContext); if (!study) throw new Error("Study provider is required"); return study; }

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    library: "M4 4h4v16H4z M10 4h4v16h-4z M16 5l3-1 4 15-3 1z",
    plus: "M12 5v14 M5 12h14", arrow: "M5 12h14 M13 6l6 6-6 6",
    back: "M19 12H5 M11 6l-6 6 6 6", search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    settings: "M5 4v16 M12 4v16 M19 4v16 M2 8h6 M9 16h6 M16 9h6",
    sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 1v3 M12 20v3 M1 12h3 M20 12h3 M4 4l2 2 M18 18l2 2 M4 20l2-2 M18 6l2-2",
    moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11",
    desktop: "M3 3h18v13H3z M12 16v5 M7 21h10", phone: "M7 2h10v20H7z M10 18h4",
    check: "M5 12l4 4L20 5", link: "M10 13l4-4 M8 15l-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0 M16 9l2-2a3 3 0 0 0-4-4l-5 5a3 3 0 0 0 0 4",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2", alert: "M12 3L2 21h20z M12 9v5 M12 17v1",
    book: "M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1z M12 5v15",
    download: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.book}/></svg>;
}
