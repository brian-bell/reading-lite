import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/AppShell";
import { useThemePreference } from "../src/components/use-theme-preference";
import type { ThemePreference } from "../src/theme";

async function renderShell(path = "/", theme: ThemePreference = "system", onThemeChange = vi.fn()) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell theme={theme} onThemeChange={onThemeChange}>
        <Outlet />
      </AppShell>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <h1>Library</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/save", component: () => <h1>Save reading</h1> }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
  return { router, onThemeChange };
}

describe("AppShell", () => {
  it("makes the skip link the first focusable element, targeting main", async () => {
    await renderShell();
    const user = userEvent.setup();
    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("marks Save reading current, not Library, on /save", async () => {
    await renderShell("/save");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: /Save reading/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /Library/ })).not.toHaveAttribute("aria-current");
  });

  it("marks Library current on the library", async () => {
    await renderShell("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: /Library/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /Save reading/ })).not.toHaveAttribute("aria-current");
  });

  it("puts the System/Light/Dark control inside the navigation", async () => {
    await renderShell("/", "dark");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const group = within(nav).getByRole("radiogroup", { name: "Theme" });
    expect(within(group).getByRole("radio", { name: "System" })).not.toBeChecked();
    expect(within(group).getByRole("radio", { name: "Light" })).not.toBeChecked();
    expect(within(group).getByRole("radio", { name: "Dark" })).toBeChecked();
  });

  it("reports a theme choice", async () => {
    const { onThemeChange } = await renderShell("/", "system");
    await userEvent.setup().click(screen.getByRole("radio", { name: "Light" }));
    expect(onThemeChange).toHaveBeenCalledWith("light");
  });
});

describe("useThemePreference", () => {
  it("starts from the server's preference and persists a change in the cookie", () => {
    document.cookie = "theme=; Max-Age=0; Path=/";
    const { result } = renderHook(() => useThemePreference("system"));
    expect(result.current[0]).toBe("system");
    act(() => result.current[1]("dark"));
    expect(result.current[0]).toBe("dark");
    expect(document.cookie).toContain("theme=dark");
    act(() => result.current[1]("system"));
    expect(document.cookie).toContain("theme=system");
  });
});
