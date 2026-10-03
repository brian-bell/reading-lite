/** Study state shared with every screen, and the stroke icons. Local simulation only. */
import { createContext, useContext } from "react";
import type { InboxItem, Reading } from "./samples";
import type { Outcome, ProviderState, Route, Scenario, View } from "./study";

export type Study = {
  route: Route;
  go: (view: View, id?: string, extra?: Partial<Route>) => void;
  hrefFor: (view: View, id?: string, extra?: Partial<Route>) => string;
  lookup: (id: string) => { reading: Reading; sample: boolean } | undefined;
  follow: (id: string) => void;
  back: () => void;
  home: () => void;
  items: Reading[];
  scenario: Scenario;
  signedIn: boolean;
  signIn: () => void;
  tabs: Record<string, "summary" | "source">;
  setTab: (id: string, tab: "summary" | "source") => void;
  captureMode: "url" | "markdown";
  setCaptureMode: (mode: "url" | "markdown") => void;
  outcome: Outcome;
  setOutcome: (outcome: Outcome) => void;
  capture: (url: string, markdown: string) => string | null;
  checkStatus: (id: string) => void;
  retry: (id: string) => void;
  provider: ProviderState;
  setProvider: (state: ProviderState) => void;
  inbox: InboxItem[];
  promote: (id: string) => void;
  discard: (id: string) => void;
  // Desk
  deskIds: string[];
  toggleDesk: (id: string) => void;
  done: (id: string) => void;
  lastVisit: string;
  sampleStep: number;
  setSampleStep: (step: number) => void;
};

export const StudyContext = createContext<Study | null>(null);

export function useStudy(): Study {
  const study = useContext(StudyContext);
  if (!study) throw new Error("StudyContext is required");
  return study;
}

const PATHS: Record<string, string> = {
  library: "M4 4h4v16H4z M10 4h4v16h-4z M16 5l3-1 4 15-3 1z",
  plus: "M12 5v14 M5 12h14",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  back: "M19 12H5 M11 6l-6 6 6 6",
  search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  sliders: "M6 4v16 M12 4v16 M18 4v16 M3 15h6 M9 9h6 M15 13h6",
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 1v3 M12 20v3 M1 12h3 M20 12h3 M4 4l2 2 M18 18l2 2 M4 20l2-2 M18 6l2-2",
  moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11",
  desktop: "M3 3h18v13H3z M12 16v5 M7 21h10",
  phone: "M7 2h10v20H7z M10 18h4",
  check: "M5 12l4 4L20 5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2",
  alert: "M12 3L2 21h20z M12 9v5 M12 17v1",
  inbox: "M4 13h4l1.5 3h5l1.5-3h4 M6.5 5h11L20 13v6H4v-6z",
  thread: "M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M6 8v3a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v-3",
  desk: "M3 9h18 M5 9v10 M19 9v10 M8 5h8l2 4H6z",
  user: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M4 21a8 8 0 0 1 16 0",
  mail: "M3 6h18v12H3z M3 7l9 6 9-6",
  index: "M4 5h16 M4 10h10 M4 15h16 M4 20h10",
  close: "M6 6l12 12 M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  "chevron-down": "M6 9l6 6 6-6",
  download: "M12 4v11 M7 10l5 5 5-5 M5 20h14",
  book: "M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1z M12 5v15",
};

export function Icon({ name, size = 18, strokeWidth = 1.5 }: { name: string; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? PATHS.book} />
    </svg>
  );
}
