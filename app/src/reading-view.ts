// The reading's view state, `?view=source` (acceptance matrix, Routes:
// "Source view; absent or any other value means Summary"). Nothing else about
// the reading page lives in the URL. Switching views replaces the history
// entry (design spec, Routes and navigation state), so Back leaves the reading
// instead of toggling views; a reload or a deep link keeps the view.

export type ReadingView = "summary" | "source";

export interface ReadingSearch {
  view?: "source";
}

/** The route's validateSearch: only the exact string `source` survives. */
export function validateReadingSearch(search: Record<string, unknown>): ReadingSearch {
  return search.view === "source" ? { view: "source" } : {};
}

export function readingViewOf(search: ReadingSearch): ReadingView {
  return search.view === "source" ? "source" : "summary";
}

/** The search a view is written back as: Summary is the URL without `view`. */
export function searchForView(view: ReadingView): ReadingSearch {
  return view === "source" ? { view: "source" } : {};
}
