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
import { catalogEmptyCopy, catalogSearchOf, catalogViewOf } from "../src/catalog";
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
      ["/library?q=a+b&tag=ai&offset=20", "/library?q=a+b&tag=ai&offset=20"],
      ["/library?q=a&view=source", "/library?q=a"],
      ["/?q=a+b&tag=ai&offset=20", "/library?q=a+b&tag=ai&offset=20"],
      ["/?view=source", "/"],
      ["/account/provider?key=sk-proj-abc", "/account/provider"],
      ["/readings/rd_ONE?next=https://evil.example", "/readings/rd_ONE"],
      ["/threads?view=source", "/threads"],
      ["/threads/rd_ONE?offset=20", "/threads/rd_ONE"],
      ["/catalog", "/catalog"],
      ["/catalog?kind=hosts&q=focus&offset=20", "/catalog?kind=hosts&q=focus&offset=20"],
      ["/catalog?person=+&org=Acme&tag=ai&limit=10&mode=text", "/catalog?org=Acme"],
      [
        "/catalog?org=Acme&person=Ada&q=focus&kind=hosts&offset=20&tag=x&limit=5&mode=meaning",
        "/catalog?kind=hosts&q=focus&offset=20&person=Ada",
      ],
      ["/catalog?keyword=Attention&host=example.com", "/catalog?keyword=Attention"],
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

  it("reads a catalog URL as one view and writes that view back", () => {
    expect(catalogViewOf({})).toEqual({ mode: "index", kind: "people" });
    expect(catalogSearchOf({ mode: "index", kind: "people" })).toEqual({});
    expect(catalogViewOf({ kind: "nope" })).toEqual({ mode: "index", kind: "people" });
    expect(catalogViewOf({ kind: "keywords" })).toEqual({ mode: "index", kind: "keywords" });
    expect(catalogSearchOf({ mode: "index", kind: "keywords" })).toEqual({ kind: "keywords" });
    expect(catalogViewOf({ person: "   " })).toEqual({ mode: "index", kind: "people" });
    expect(catalogViewOf({ org: "Acme", person: " Ada " })).toEqual({
      mode: "term",
      facet: { kind: "people", term: "Ada" },
      offset: 0,
    });
    expect(catalogSearchOf({ mode: "term", facet: { kind: "people", term: "Ada" }, offset: 0 })).toEqual({
      person: "Ada",
    });
    expect(catalogViewOf({ person: "Ada", q: "focus", kind: "hosts", offset: "40" })).toEqual({
      mode: "term",
      facet: { kind: "people", term: "Ada" },
      q: "focus",
      offset: 40,
    });
    expect(
      catalogSearchOf({ mode: "term", facet: { kind: "people", term: "Ada" }, q: "focus", offset: 40 }),
    ).toEqual({ person: "Ada", q: "focus", offset: "40" });
    const found = catalogViewOf({ q: "focus", kind: "hosts", person: "   ", offset: "40" });
    expect(found).toEqual({ mode: "text", q: "focus", kind: "hosts", offset: 40 });
    expect(catalogSearchOf(found)).toEqual({ q: "focus", kind: "hosts", offset: "40" });
    expect(catalogSearchOf({ mode: "text", q: "focus", kind: "people", offset: 0 })).toEqual({ q: "focus" });
    expect(catalogEmptyCopy({ mode: "term", facet: { kind: "people", term: "Ada" }, offset: 0 })).toBe(
      "No readings mention “Ada”.",
    );
    expect(catalogEmptyCopy({ mode: "text", q: "focus", kind: "people", offset: 0 })).toBe(
      "No readings match “focus”.",
    );
    expect(catalogEmptyCopy({ mode: "term", facet: { kind: "people", term: "Ada" }, q: "focus", offset: 0 })).toBe(
      "No readings mention “Ada” and match “focus”.",
    );
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

  // Acceptance matrix, Desk writes: the toggle knows the cap from the desk
  // read, before any write; a 404 frees the gone reading's slot; a 409 is
  // said inline; a write refreshes the desk, the library and the reading.
  it("writes the desk, refreshes what it changed, and says why a toggle cannot add", async () => {
    let onDesk = ["rd_b", "rd_c", "rd_d"];
    const writes: [answer: Response, after: string[]][] = [
      [new Response(JSON.stringify({ error: "not found" }), { status: 404 }), ["rd_c", "rd_d"]],
      [new Response(JSON.stringify({ error: "nope", code: "not_ready" }), { status: 409 }), ["rd_c", "rd_d"]],
      [new Response(JSON.stringify({ desk: ["rd_c", "rd_d", "rd_a"] })), ["rd_c", "rd_d", "rd_a"]],
    ];
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        if (request.method === "GET" && new URL(request.url).pathname === "/api/desk") {
          const rows = onDesk.map((id) => ({ id, url: `https://example.com/${id}`, status: "ready", title: id }));
          return new Response(
            JSON.stringify({
              on_desk: rows,
              needs_you: [],
              needs_you_total: 0,
              processing: [],
              processing_total: 0,
              ready_since: [],
              ready_since_total: 0,
            }),
          );
        }
        calls.push(request);
        const [answer, after] = writes.shift()!;
        onDesk = after;
        return answer;
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
    await waitFor(() => expect(put[0], "a full desk is known from the read").toBeDisabled());
    expect(put[1]).toBeDisabled();
    expect(toggles.getAllByText("Three readings at a time"), "with the reason in text").toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Take off desk" }));
    await waitFor(() => expect(put[1], "a reading purged elsewhere frees its slot").toBeEnabled());
    fireEvent.click(put[1]!);
    expect(await toggles.findByText("Only ready readings can go on the desk")).toBeVisible();

    for (const key of [["library", { offset: 0 }], ["reading", "rd_a"], ["reading", "rd_x"]]) {
      queryClient.setQueryData(key, {});
    }
    fireEvent.click(put[0]!);
    await waitFor(() => expect(put[1], "a fourth is held back").toBeDisabled());
    const post = calls[2]!;
    expect(post.method).toBe("POST");
    expect(new URL(post.url).pathname).toBe("/api/desk");
    expect(await post.json()).toEqual({ id: "rd_a" });
    expect(post.headers.get("x-expected-tenant"), "pinned to the rendered account").toBe("usr_a");
    const invalidated = (key: unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
    await waitFor(() =>
      expect(
        [invalidated(["library", { offset: 0 }]), invalidated(["reading", "rd_a"]), invalidated(["reading", "rd_x"])],
        "the library and this reading, not another",
      ).toEqual([true, true, false]),
    );
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
