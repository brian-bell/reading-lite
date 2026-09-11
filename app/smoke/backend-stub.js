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

  async reading() {
    return { status: 404, body: { error: "not found" } };
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
