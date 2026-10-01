import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DmcaPage, LegalFooter, LoginLegalLinks, PrivacyPage, TermsPage } from "../src/components/LegalPages";
import { OPERATOR_CONTACT_EMAIL } from "../src/legal-copy";

async function renderLegal(path: string, extras: { loginLinks?: boolean } = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        {extras.loginLinks ? <LoginLegalLinks /> : null}
        <LegalFooter />
      </>
    ),
  });
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/terms", component: TermsPage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/privacy", component: PrivacyPage }),
    createRoute({ getParentRoute: () => rootRoute, path: "/dmca", component: DmcaPage }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
  return router;
}

describe("legal pages", () => {
  it.each([
    ["/terms", "Terms of Service", "About these terms"],
    ["/privacy", "Privacy Policy", "Who is responsible"],
    ["/dmca", "Copyright Complaints", "Report a copyright concern"],
  ] as const)("renders %s with its title and first section", async (path, title, section) => {
    await renderLegal(path);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: section })).toBeInTheDocument();
    expect(screen.getByText(/Last updated: October 1, 2026/)).toBeInTheDocument();
  });

  it("turns the operator address into a mailto link", async () => {
    await renderLegal("/terms");
    const mail = screen.getAllByRole("link", { name: OPERATOR_CONTACT_EMAIL })[0];
    expect(mail).toHaveAttribute("href", `mailto:${OPERATOR_CONTACT_EMAIL}`);
  });

  it("does not link the current document's name in the body", async () => {
    await renderLegal("/terms");
    const about = document.querySelector("#about")!;
    expect(within(about as HTMLElement).queryByRole("link", { name: "Terms" })).toBeNull();
  });

  it("cross-links the other legal pages and marks the footer current", async () => {
    await renderLegal("/privacy");
    const cross = screen.getByRole("navigation", { name: "Other legal pages" });
    expect(within(cross).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(within(cross).getByRole("link", { name: "Copyright" })).toHaveAttribute("href", "/dmca");
    expect(within(cross).queryByRole("link", { name: "Privacy" })).toBeNull();

    const footer = screen.getByRole("contentinfo");
    const nav = within(footer).getByRole("navigation", { name: "Legal" });
    expect(within(nav).getByRole("link", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Terms" })).not.toHaveAttribute("aria-current");
  });

  it("follows a footer link to another legal page", async () => {
    await renderLegal("/terms");
    await userEvent.setup().click(within(screen.getByRole("contentinfo")).getByRole("link", { name: "Copyright" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Copyright Complaints" })).toBeInTheDocument();
  });
});

describe("LoginLegalLinks", () => {
  it("names Terms and Privacy and lists every legal page", async () => {
    await renderLegal("/terms", { loginLinks: true });
    expect(screen.getByText(/By continuing, you agree to our/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    const loginNav = screen.getAllByRole("navigation", { name: "Legal" })[0];
    expect(within(loginNav).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(within(loginNav).getByRole("link", { name: "Copyright" })).toHaveAttribute("href", "/dmca");
  });
});
