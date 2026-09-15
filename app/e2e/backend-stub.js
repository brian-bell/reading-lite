// Stand-in for the backend's FrontendReads entrypoint (the repo root's
// src/frontend-reads.ts) in the browser-evidence suite: same method names and
// result shape, canned identities per session cookie, and reading detail and
// the library's list served from the fixture pack snapshot (#366 via
// scripts/emit-app-fixture-pack.ts).
// Plain JavaScript so the app's TypeScript config doesn't need the full Workers
// runtime types, as smoke/backend-stub.js is.
//
// Unlike the smoke stub this one accepts any host: Playwright drives the
// harness on 127.0.0.1, and host forwarding already has its evidence in
// smoke/worker.test.ts.
import { WorkerEntrypoint } from "cloudflare:workers";
import pack from "./fixtures/fixture-pack.json";
import { libraryPage } from "./library-page.js";

// Sessions the suite signs in with. e2e/sessions.ts holds the cookie names the
// browser sets; keep the two in step.
const SESSIONS = {
  "reader-a": {
    tenant_id: "usr_aaaaaaaa",
    user_id: "usr_aaaaaaaa",
    principal: "session",
    tenant_data_plane: true,
    email: "reader-a@example.com",
    csrf_token: "csrf-token-for-a",
  },
};

function sessionOf(cookie) {
  const match = /(?:^|;\s*)(?:__Host-session|e2e-session)=([^;]+)/.exec(cookie ?? "");
  return match ? SESSIONS[match[1]] : undefined;
}

export class FrontendReads extends WorkerEntrypoint {
  async whoami({ cookie }) {
    const identity = sessionOf(cookie);
    return identity ? { status: 200, body: identity } : { status: 401, body: { error: "unauthorized" } };
  }

  async list({ cookie, q, tag, offset }) {
    if (!sessionOf(cookie)) return { status: 401, body: { error: "unauthorized" } };
    return { status: 200, body: libraryPage(pack.list_index.items, { q, tag, offset }) };
  }

  async reading({ cookie, id }) {
    if (!sessionOf(cookie)) return { status: 401, body: { error: "unauthorized" } };
    const body = pack.readings[id];
    return body ? { status: 200, body } : { status: 404, body: { error: "not found" } };
  }
}

export default {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
};
