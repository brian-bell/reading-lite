import { useCallback, useState } from "react";
import { serializeThemeCookie, type ThemePreference } from "../theme";

/**
 * Holds the theme preference for the document. The server render supplies the
 * initial value from the cookie; a change updates `<html data-theme>` through
 * React and writes the cookie so the next server render matches.
 */
export function useThemePreference(initial: ThemePreference) {
  const [preference, setPreference] = useState(initial);
  const update = useCallback((next: ThemePreference) => {
    document.cookie = serializeThemeCookie(next, { secure: window.location.protocol === "https:" });
    setPreference(next);
  }, []);
  return [preference, update] as const;
}
