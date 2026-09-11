// Theme preference (design spec, Themes and contrast): System (default), Light,
// or Dark, kept in a first-party cookie so the server render picks the theme
// without a flash. The cookie carries no identity. It is not HttpOnly because
// the navigation toggle writes it from the browser.

export type ThemePreference = "system" | "light" | "dark";

export const THEME_COOKIE = "theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readThemeFromCookieHeader(header: string | null | undefined): ThemePreference {
  if (!header) return "system";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === THEME_COOKIE) {
      return parseThemePreference(part.slice(separator + 1).trim());
    }
  }
  return "system";
}

export function serializeThemeCookie(preference: ThemePreference, { secure }: { secure: boolean }): string {
  const cookie = `${THEME_COOKIE}=${preference}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  return secure ? `${cookie}; Secure` : cookie;
}

/** Value for `<html data-theme>`; System leaves it unset for the media query. */
export function themeAttribute(preference: ThemePreference): "light" | "dark" | undefined {
  return preference === "system" ? undefined : preference;
}
