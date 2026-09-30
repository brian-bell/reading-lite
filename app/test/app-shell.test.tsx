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
import type { SignOutResult } from "../src/auth/session";
import { AppShell, type AccountState } from "../src/components/AppShell";
import { useThemePreference } from "../src/components/use-theme-preference";
import type { ThemePreference } from "../src/theme";

async function renderShell(
  path = "/",
  theme: ThemePreference = "system",
  onThemeChange = vi.fn(),
  account: AccountState = { status: "unknown" },
  onSignOut: () => Promise<SignOutResult> = vi.fn(async (): Promise<SignOutResult> => "signed-out"),
) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell theme={theme} onThemeChange={onThemeChange} account={account} onSignOut={onSignOut}>
        <Outlet />
      </AppShell>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <h1>Library</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/save", component: () => <h1>Save reading</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: () => <h1>Sign in</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/auth/verify", component: () => <h1>Complete sign-in</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/terms", component: () => <h1>Terms of Service</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/privacy", component: () => <h1>Privacy Policy</h1> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/dmca", component: () => <h1>Copyright Complaints</h1> }),
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

  it("links to the public legal pages from the footer", async () => {
    await renderShell();
    const footer = screen.getByRole("contentinfo");
    const nav = within(footer).getByRole("navigation", { name: "Legal" });
    expect(within(nav).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(within(nav).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(within(nav).getByRole("link", { name: "Copyright" })).toHaveAttribute("href", "/dmca");
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

describe("AppShell account menu", () => {
  it("shows the signed-in email, Account, Provider, and Sign out inside the navigation", async () => {
    await renderShell("/", "system", vi.fn(), { status: "signed-in", email: "a@example.com" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    const menu = within(nav).getByRole("group", { name: "Account menu, signed in as a@example.com" });
    const toggle = within(menu).getByText("Account", { selector: "summary *" });
    expect(within(menu).getByText("a@example.com")).toBeInTheDocument();
    expect(within(menu).getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account/security");
    expect(within(menu).getByRole("link", { name: "Provider" })).toHaveAttribute("href", "/account/provider");
    expect(within(menu).getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(within(nav).queryByRole("link", { name: "Sign in" })).toBeNull();

    const details = menu.closest("details")!;
    expect(details.open).toBe(false);
    await userEvent.setup().click(toggle);
    expect(details.open).toBe(true);
  });

  it("closes the open menu on Escape and returns focus to its toggle", async () => {
    await renderShell("/", "system", vi.fn(), { status: "signed-in", email: "a@example.com" });
    const user = userEvent.setup();
    const summary = document.querySelector<HTMLElement>(".account-menu summary")!;
    await user.click(summary);
    await user.keyboard("{Escape}");
    expect(summary.closest("details")!.open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it("signs out once, holding the button while it runs", async () => {
    let finish: (result: SignOutResult) => void = () => undefined;
    const onSignOut = vi.fn(() => new Promise<SignOutResult>((resolve) => (finish = resolve)));
    await renderShell("/", "system", vi.fn(), { status: "signed-in", email: "a@example.com" }, onSignOut);
    const user = userEvent.setup();
    await user.click(document.querySelector<HTMLElement>(".account-menu summary")!);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    await act(async () => finish("signed-out"));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // A failed logout leaves the session alive; saying "signed out" over a live
  // session is the dangerous answer on a shared device (#369 review).
  it("says the reader is still signed in when sign-out fails", async () => {
    const onSignOut = vi.fn(async (): Promise<SignOutResult> => "still-signed-in");
    await renderShell("/", "system", vi.fn(), { status: "signed-in", email: "a@example.com" }, onSignOut);
    const user = userEvent.setup();
    await user.click(document.querySelector<HTMLElement>(".account-menu summary")!);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t sign out. You are still signed in.");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it.each(["/login", "/auth/verify"])("shows no sign-in link on %s itself", async (path) => {
    await renderShell(path, "system", vi.fn(), { status: "signed-out" });
    expect(within(screen.getByRole("navigation", { name: "Main" })).queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("shows a sign-in link that returns to the current URL when signed out", async () => {
    await renderShell("/save", "system", vi.fn(), { status: "signed-out" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?next=%2Fsave");
    expect(within(nav).queryByRole("group", { name: /Account menu/ })).toBeNull();
  });

  it("shows neither while identity is unknown or unavailable", async () => {
    await renderShell("/", "system", vi.fn(), { status: "unknown" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(within(nav).queryByRole("group", { name: /Account menu/ })).toBeNull();
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
