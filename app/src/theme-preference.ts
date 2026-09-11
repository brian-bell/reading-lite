import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { THEME_COOKIE, parseThemePreference, readThemeFromCookieHeader } from "./theme";

/** Reads the theme cookie from the request on the server, or the document in the browser. */
export const getThemePreference = createIsomorphicFn()
  .server(() => parseThemePreference(getCookie(THEME_COOKIE)))
  .client(() => readThemeFromCookieHeader(document.cookie));
