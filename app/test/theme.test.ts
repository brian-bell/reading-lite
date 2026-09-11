// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  THEME_COOKIE,
  parseThemePreference,
  readThemeFromCookieHeader,
  serializeThemeCookie,
  themeAttribute,
} from "../src/theme";

describe("parseThemePreference", () => {
  it.each(["system", "light", "dark"] as const)("accepts %s", (value) => {
    expect(parseThemePreference(value)).toBe(value);
  });

  it.each([undefined, "", "Dark", "blue", "dark;"])("treats %s as system", (value) => {
    expect(parseThemePreference(value)).toBe("system");
  });
});

describe("readThemeFromCookieHeader", () => {
  it("reads the theme cookie among others", () => {
    expect(readThemeFromCookieHeader("a=1; theme=dark; __Host-session=x")).toBe("dark");
    expect(readThemeFromCookieHeader("theme=light")).toBe("light");
  });

  it("defaults to system when absent or invalid", () => {
    expect(readThemeFromCookieHeader(null)).toBe("system");
    expect(readThemeFromCookieHeader("")).toBe("system");
    expect(readThemeFromCookieHeader("themes=dark")).toBe("system");
    expect(readThemeFromCookieHeader("theme=purple")).toBe("system");
  });
});

describe("serializeThemeCookie", () => {
  it("writes a first-party, year-long, Lax cookie", () => {
    const cookie = serializeThemeCookie("dark", { secure: true });
    expect(cookie).toBe(`${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  });

  it("omits Secure on plain-http local development", () => {
    expect(serializeThemeCookie("light", { secure: false })).not.toContain("Secure");
  });

  it("never marks the cookie HttpOnly, so the navigation toggle can write it", () => {
    expect(serializeThemeCookie("system", { secure: true })).not.toContain("HttpOnly");
  });
});

describe("themeAttribute", () => {
  it("maps explicit themes to data-theme and leaves system to the media query", () => {
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
    expect(themeAttribute("system")).toBeUndefined();
  });
});
