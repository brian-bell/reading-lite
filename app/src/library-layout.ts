import { useCallback, useSyncExternalStore } from "react";

// The library's Cards / Rows switch (design spec, Screens: Library). Cosmetic,
// so it lives in localStorage rather than a cookie: the server render is
// always Cards, and a reader who chose Rows sees them once the page hydrates.
// Storage can be unavailable (private modes, blocked site data); the switch
// then lasts for the page.

export type LibraryLayout = "cards" | "rows";

export const LIBRARY_LAYOUT_STORAGE_KEY = "reading-lite.libraryLayout";

const listeners = new Set<() => void>();
let unstored: LibraryLayout | undefined;

function read(): LibraryLayout {
  try {
    const stored = window.localStorage.getItem(LIBRARY_LAYOUT_STORAGE_KEY);
    if (stored === "rows" || stored === "cards") return stored;
  } catch {
    // See above.
  }
  return unstored ?? "cards";
}

function write(layout: LibraryLayout): void {
  unstored = layout;
  try {
    window.localStorage.setItem(LIBRARY_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // See above.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LIBRARY_LAYOUT_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useLibraryLayout(): [LibraryLayout, (layout: LibraryLayout) => void] {
  const layout = useSyncExternalStore(subscribe, read, () => "cards" as const);
  return [layout, useCallback(write, [])];
}
