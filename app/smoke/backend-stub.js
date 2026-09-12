// Stand-in for the backend's FrontendReads entrypoint (the repo root's
// src/frontend-reads.ts) in smoke tests: same method names and result shape,
// canned identities per session cookie. Plain JavaScript so the app's
// TypeScript config doesn't need the full Workers runtime types.
//
// Each tenant answers after a different delay so concurrent renders interleave.
// Only the forwarded host the tests use is accepted, proving the frontend
// passes the request host through.
import { WorkerEntrypoint } from "cloudflare:workers";

const SMOKE_HOST = "next.readinglite.test";

const SESSIONS = {
  "session-a": {
    delayMs: 40,
    identity: {
      tenant_id: "usr_aaaaaaaa",
      user_id: "usr_aaaaaaaa",
      principal: "session",
      tenant_data_plane: true,
      email: "reader-a@example.com",
      csrf_token: "csrf-token-for-a",
    },
  },
  "session-b": {
    delayMs: 5,
    identity: {
      tenant_id: "usr_bbbbbbbb",
      user_id: "usr_bbbbbbbb",
      principal: "session",
      tenant_data_plane: true,
      email: "reader-b@example.com",
      csrf_token: "csrf-token-for-b",
    },
  },
};

const READING = {
  id: "rd_0123456789",
  url: "https://fieldnotes.example/2026/a-quieter-internet",
  status: "ready",
  title: "A quieter internet is a choice we can make",
  created_at: "2026-09-07T09:30:00.000Z",
  // Enough of a ready manifest to prove the whole Summary view is server
  // rendered: the lead, the summary below it, the tags, and the novelty panel.
  tldr: "A personal library can turn the internet into a place for deliberate reading.",
  summary_markdown:
    "A personal library can turn the internet into a place for deliberate reading.\n\nSaving is only the beginning.",
  tags: ["attention", "design"],
  novelty_verdict: "familiar",
  similarity: { count: 2, max: 0.61, mean: 0.58 },
};

function sessionOf(cookie) {
  const match = /(?:^|;\s*)__Host-session=([^;]+)/.exec(cookie ?? "");
  return match ? SESSIONS[match[1]] : undefined;
}

export class FrontendReads extends WorkerEntrypoint {
  async whoami({ cookie, host }) {
    if (host !== SMOKE_HOST) return { status: 400, body: { error: "invalid request" } };
    if (cookie?.includes("__Host-session=backend-down")) throw new Error("backend unavailable");
    const session = sessionOf(cookie);
    if (!session) return { status: 401, body: { error: "unauthorized" } };
    await new Promise((resolve) => setTimeout(resolve, session.delayMs));
    return { status: 200, body: session.identity };
  }

  // One ready reading, so a server render has something real to produce; any
  // other id is a reading this tenant does not have. The pin is echoed back in
  // the identity check above, not here: an expected-tenant mismatch is the
  // backend's own middleware in production.
  async reading({ cookie, host, id }) {
    if (host !== SMOKE_HOST) return { status: 400, body: { error: "invalid request" } };
    if (cookie?.includes("__Host-session=backend-down")) throw new Error("backend unavailable");
    if (!sessionOf(cookie)) return { status: 401, body: { error: "unauthorized" } };
    if (id !== READING.id) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: READING };
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
