import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  CURRENT_BEHAVIOR_NOTICE,
  OPERATOR_CONTACT_URL,
  PRIVACY_DELETION_SECTION
} from "./legal-copy";

const sessionWhoami = {
  tenant_id: "usr_550e8400-e29b-41d4-a716-446655440000",
  user_id: "usr_550e8400-e29b-41d4-a716-446655440000",
  principal: "session" as const,
  tenant_data_plane: true,
  email: "reader@example.com",
  csrf_token: "ab".repeat(32)
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stubWhoami(signedIn: boolean) {
  const fetchMock = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/login-options") {
      return jsonResponse({ turnstile_site_key: null });
    }
    if (url.pathname === "/api/whoami") {
      if (!signedIn) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse(sessionWhoami);
    }
    return jsonResponse({ readings: [], limit: 20, offset: 0, has_more: false });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function footer() {
  return screen.getByRole("contentinfo");
}

function deletionLead(): string {
  const lead = PRIVACY_DELETION_SECTION.blocks[0];
  if (lead?.type !== "p") throw new Error("deletion lead is not a paragraph");
  return lead.text;
}

describe("legal routes and links", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders public Terms while signed out", async () => {
    stubWhoami(false);
    render(<App initialPath="/terms" />);
    expect(await screen.findByRole("heading", { name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(CURRENT_BEHAVIOR_NOTICE);
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("renders public Privacy deletion copy while signed out", async () => {
    stubWhoami(false);
    render(<App initialPath="/privacy" />);
    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deletion" })).toBeInTheDocument();
    expect(screen.getByText(deletionLead())).toBeInTheDocument();
  });

  it("renders public DMCA with the GitHub contact, not a mailbox", async () => {
    stubWhoami(false);
    render(<App initialPath="/dmca" />);
    expect(await screen.findByRole("heading", { name: "DMCA" })).toBeInTheDocument();
    const contacts = screen.getAllByRole("link", { name: "github.com/brian-bell/reading-lite" });
    expect(contacts.length).toBeGreaterThan(0);
    for (const link of contacts) {
      expect(link).toHaveAttribute("href", OPERATOR_CONTACT_URL);
    }
    expect(screen.queryByRole("link", { name: /mailto:/i })).not.toBeInTheDocument();
  });

  it("keeps legal pages reachable while signed in instead of replacing them with the library", async () => {
    stubWhoami(true);
    render(<App initialPath="/privacy" />);
    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reading Library" })).not.toBeInTheDocument();
    expect(await screen.findByText("reader@example.com")).toBeInTheDocument();
  });

  it("links Terms, Privacy, and DMCA from the footer and the login page", async () => {
    stubWhoami(false);
    const user = userEvent.setup();
    render(<App initialPath="/login" />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();

    const footerNav = within(footer()).getByRole("navigation", { name: "Legal" });
    expect(within(footerNav).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(within(footerNav).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(within(footerNav).getByRole("link", { name: "DMCA" })).toHaveAttribute("href", "/dmca");

    expect(screen.getByText("Draft pages describing current product behavior:")).toBeInTheDocument();
    const loginLinks = screen.getByText("Draft pages describing current product behavior:").parentElement;
    expect(loginLinks).not.toBeNull();
    expect(within(loginLinks!).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");

    await user.click(within(footerNav).getByRole("link", { name: "Privacy" }));
    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeInTheDocument();
    expect(within(footer()).getByRole("link", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
  });

  it("navigates between legal pages from the on-page cross links", async () => {
    stubWhoami(false);
    const user = userEvent.setup();
    render(<App initialPath="/terms" />);
    expect(await screen.findByRole("heading", { name: "Terms of Service" })).toBeInTheDocument();
    const cross = screen.getByRole("navigation", { name: "Other legal pages" });
    await user.click(within(cross).getByRole("link", { name: "DMCA" }));
    expect(await screen.findByRole("heading", { name: "DMCA" })).toBeInTheDocument();
  });

  it("still sends unknown paths through the SPA catch-all", async () => {
    stubWhoami(true);
    render(<App initialPath="/not-a-legal-page" />);
    expect(await screen.findByRole("heading", { name: "Reading Library" })).toBeInTheDocument();
  });
});
