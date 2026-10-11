// The frontend's guards no other layer catches: the API client's same-origin
// and CSRF rules, the return-path allowlist, a 401 as the only sign-out, the
// save and reprocess refusals the pages render as states, the desk toggle's
// write, and untrusted Markdown kept off the page. The smoke suite owns the built Worker's routes
// and tenant isolation; the browser suite owns a real sign-in and save.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER, apiFetch } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { LOGIN_NEXT_STORAGE_KEY, consumeReturnPath, rememberReturnPath, safeReturnPath } from "../src/auth/return-path";
import { createQueryClient, sessionEndedQueryKey } from "../src/auth/session";
import { DeskToggle } from "../src/components/DeskToggle";
import { ReadingSummary } from "../src/components/ReadingSummary";
import { SourceMarkdown } from "../src/components/ReadingSource";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { Reading } from "../src/reading";
import { reprocessFromResponse } from "../src/reprocess";
import { saveUrlProblem, submitFromResponse } from "../src/save";

function identity(csrf: string): Identity {
  return {
    tenant_id: "usr_a",
    user_id: "usr_a",
    principal: "session",
    tenant_data_plane: true,
    email: "a@example.com",
    csrf_token: csrf,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("frontend guards", () => {
  // ADR 0003, Browser requests: same-origin /api/* with the session cookie,
  // and the CSRF token from this client's own whoami on every write.
  it("sends API requests same-origin, with only this client's CSRF token on writes", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        calls.push(request);
        return new Response("{}");
      }),
    );
    const mine = new QueryClient();
    const theirs = new QueryClient();
    mine.setQueryData(whoamiQueryKey, identity("csrf-mine"));
    theirs.setQueryData(whoamiQueryKey, identity("csrf-theirs"));

    await apiFetch(mine, "/api/readings");
    await apiFetch(mine, "/api/readings", { method: "POST" });
    await apiFetch(mine, "/api/sessions/ses_1", { method: "DELETE" });
    await apiFetch(new QueryClient(), "/api/auth/logout", { method: "POST" });
    expect(calls.map((call) => call.url), "same origin").toEqual(
      ["/api/readings", "/api/readings", "/api/sessions/ses_1", "/api/auth/logout"].map(
        (path) => `${window.location.origin}${path}`,
      ),
    );
    expect(calls.every((call) => call.credentials === "include"), "with the session cookie").toBe(true);
    expect(calls.map((call) => call.headers.get(CSRF_HEADER)), "CSRF on writes, from this client only").toEqual([
      null,
      "csrf-mine",
      "csrf-mine",
      null,
    ]);

    for (const path of ["https://evil.example/api/whoami", "//evil.example/api/whoami", "/health", "api/whoami"]) {
      await expect(apiFetch(mine, path), path).rejects.toThrow(/same-origin \/api/);
    }
    expect(calls, "nothing sent off-origin").toHaveLength(4);
  });

  // Sign-in returns the reader to `next` or a remembered path; neither may
  // leave this origin or reach a page outside the allowlist.
  it("returns only to allowlisted same-origin paths, from the query or storage", () => {
    for (const [raw, expected] of [
      ["/readings/rd_ONE?view=source", "/readings/rd_ONE?view=source"],
      ["/?q=a+b&tag=ai&offset=20", "/?q=a+b&tag=ai&offset=20"],
      ["/account/provider?key=sk-proj-abc", "/account/provider"],
      ["/readings/rd_ONE?next=https://evil.example", "/readings/rd_ONE"],
      ["/threads?view=source", "/threads"],
      ["/threads/rd_ONE?offset=20", "/threads/rd_ONE"],
    ]) {
      expect(safeReturnPath(raw), raw).toBe(expected);
    }
    for (const raw of [
      "https://evil.example/readings/rd_ONE",
      "//evil.example/readings/rd_ONE",
      "/\\evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
      `${window.location.origin}/readings/rd_ONE`,
      "/login?next=/readings/rd_ONE",
      "/api/whoami",
      "/readings/%2F%2Fevil.example",
      "/readings/rd_ONE@evil.example",
      "/threads/rd_ONE/more",
    ]) {
      expect(safeReturnPath(raw), raw).toBeUndefined();
    }

    rememberReturnPath("//evil.example");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY), "an unsafe path is never stored").toBeNull();
    localStorage.setItem(LOGIN_NEXT_STORAGE_KEY, "https://evil.example");
    expect(consumeReturnPath("https://evil.example"), "a tampered stored path goes home").toBe("/");
    expect(localStorage.getItem(LOGIN_NEXT_STORAGE_KEY), "and is cleared").toBeNull();
  });

  // A 403 or a 5xx with a live session must not throw the reader out.
  it("ends the session on a 401 and on nothing else", async () => {
    for (const status of [401, 403, 404, 412, 500]) {
      const queryClient = createQueryClient(() => "/readings/rd_ONE");
      queryClient.setQueryData(whoamiQueryKey, identity("csrf-a"));
      await queryClient
        .fetchQuery({
          queryKey: ["reading", "rd_ONE"],
          queryFn: () => Promise.reject(new ApiError(status, "no")),
          retry: false,
        })
        .catch(() => undefined);
      expect(queryClient.getQueryData(sessionEndedQueryKey), `${status} ends the session`).toBe(
        status === 401 ? "/readings/rd_ONE" : undefined,
      );
    }
  });

  // Each refusal is a state the save and reprocess pages render with the
  // reader's input kept, never the generic server error.
  it("reads save and reprocess refusals as the states the pages render", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi"]) {
      expect(saveUrlProblem(url), url).toBe("Only http and https links can be saved.");
    }

    const refusals: [status: number, body: unknown, kind: string][] = [
      [400, { error: "url rejected: host is not allowed" }, "invalid"],
      [403, { error: "forbidden" }, "forbidden"],
      [409, { error: "reading already has an active attempt" }, "already-processing"],
      [409, { error: "connect a key, then retry", code: "provider_key_required" }, "key-required"],
      [412, { error: "expected tenant mismatch", acting_tenant: "usr_b" }, "account-changed"],
      [429, { error: "quota exhausted", code: "quota_exhausted", limit: "monthly" }, "limited"],
      [503, { error: "queue unavailable" }, "unavailable"],
    ];
    for (const [status, body, kind] of refusals) {
      expect(submitFromResponse(status, body), `save ${status} ${kind}`).toMatchObject({ kind });
      expect(reprocessFromResponse(status, body), `reprocess ${status} ${kind}`).toMatchObject({ kind });
    }
    expect(submitFromResponse(429, { error: "usage guard unavailable" }), "save usage guard").toEqual({
      kind: "guard-unavailable",
    });
    expect(reprocessFromResponse(409, { error: "markdown content not available" }), "reprocess no Markdown").toEqual({
      kind: "markdown-missing",
    });
    for (const status of [401, 500]) {
      expect(() => submitFromResponse(status, { error: "nope" }), `save ${status}`).toThrow(ApiError);
      expect(() => reprocessFromResponse(status, { error: "nope" }), `reprocess ${status}`).toThrow(ApiError);
    }
  });

  // Acceptance matrix, Desk writes: a write refreshes the desk, the library
  // and the reading; at the cap the toggle is disabled with visible text; a
  // 404 frees the gone reading's slot; a 409 is said inline.
  it("writes the desk, refreshes what it changed, and says why a toggle cannot add", async () => {
    const answers = [
      new Response(JSON.stringify({ desk: ["rd_b", "rd_c", "rd_a"] })),
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      new Response(JSON.stringify({ error: "nope", code: "not_ready" }), { status: 409 }),
    ];
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        calls.push(request);
        return answers.shift()!;
      }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(whoamiQueryKey, identity("csrf-a"));
    for (const key of [["library", { offset: 0 }], ["reading", "rd_a"], ["reading", "rd_x"]]) {
      queryClient.setQueryData(key, {});
    }
    const toggles = render(
      <QueryClientProvider client={queryClient}>
        <DeskToggle reading={{ id: "rd_a" }} />
        <DeskToggle reading={{ id: "rd_b", desk_position: 1 }} />
        <DeskToggle reading={{ id: "rd_x" }} />
      </QueryClientProvider>,
    );
    const put = screen.getAllByRole("button", { name: "Put on desk" });
    expect(screen.getByRole("button", { name: "Take off desk" }), "on the desk").toHaveAttribute("aria-pressed", "true");
    expect(put[0], "off the desk").toHaveAttribute("aria-pressed", "false");

    fireEvent.click(put[0]!);
    await waitFor(() => expect(put[1], "a fourth is held back").toBeDisabled());
    expect(toggles.getByText("Three readings at a time"), "with the reason in text").toBeVisible();
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/desk");
    expect(await calls[0]!.json()).toEqual({ id: "rd_a" });
    expect(calls[0]!.headers.get("x-expected-tenant"), "pinned to the rendered account").toBe("usr_a");
    const invalidated = (key: unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
    expect(
      [invalidated(["library", { offset: 0 }]), invalidated(["reading", "rd_a"]), invalidated(["reading", "rd_x"])],
      "the library and this reading, not another",
    ).toEqual([true, true, false]);

    fireEvent.click(screen.getByRole("button", { name: "Take off desk" }));
    await waitFor(() => expect(put[1], "a reading purged elsewhere frees its slot").toBeEnabled());
    fireEvent.click(put[1]!);
    expect(await toggles.findByText("Only ready readings can go on the desk")).toBeVisible();
  });

  // The captured page is untrusted and the summary is written from it.
  it("keeps markup, remote images, and script links in captured Markdown off the page", () => {
    const hostile =
      '<img src="https://x.example/p.gif" onerror="alert(1)"><script>alert(2)</script>\n\n' +
      "![pixel](https://tracker.example/p.gif)\n\n" +
      "See [elsewhere](https://elsewhere.example/x) and <javascript:alert(1)>.";
    const source = render(
      <SourceMarkdown markdown={hostile} base="https://fieldnotes.example/a" images={{ loaded: new Set(), onLoad: () => {} }} />,
    ).container;
    const summary = render(
      <ReadingSummary reading={{ summary_markdown: hostile } as Reading} />,
    ).container;

    for (const [name, html] of [
      ["source", source],
      ["summary", summary],
    ] as const) {
      expect(html.querySelector("script"), `${name}: no script`).toBeNull();
      expect(html.querySelector("img"), `${name}: no image loads on its own`).toBeNull();
      expect(html.innerHTML, `${name}: no handler`).not.toContain("onerror");
      expect(html.innerHTML, `${name}: no tracker`).not.toContain("tracker.example/p.gif");
      const links = [...html.querySelectorAll("a[href]")];
      expect(links.map((link) => link.getAttribute("href")), `${name}: only the http link`).toEqual([
        "https://elsewhere.example/x",
      ]);
      expect(links[0], `${name}: no referrer or opener`).toHaveAttribute("rel", "noopener noreferrer nofollow");
    }
  });
});
