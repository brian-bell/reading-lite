// Stand-in for the backend's FrontendReads entrypoint (the repo root's
// src/frontend-reads.ts) in the browser-evidence suite: same method names and
// result shape, canned identities per session cookie, and reading detail and
// the library's list served from the fixture pack snapshot (#366 via
// scripts/emit-app-fixture-pack.ts), with generated rows past it for paging.
// Plain JavaScript so the app's TypeScript config doesn't need the full Workers
// runtime types, as smoke/backend-stub.js is.
//
// Unlike the smoke stub this one accepts any host: Playwright drives the
// harness on 127.0.0.1, and host forwarding already has its evidence in
// smoke/worker.test.ts.
import { WorkerEntrypoint } from "cloudflare:workers";
import pack from "./fixtures/fixture-pack.json";
import { libraryItems, libraryPage } from "./library-page.js";
import { LIST_SCENARIOS } from "./list-scenarios.js";

// Sessions the suite signs in with. e2e/sessions.ts holds the cookie names the
// browser sets; keep the two in step.
const READER_A = {
  tenant_id: "usr_aaaaaaaa",
  user_id: "usr_aaaaaaaa",
  principal: "session",
  tenant_data_plane: true,
  email: "reader-a@example.com",
  csrf_token: "csrf-token-for-a",
};

// A new reader (reading-lite-gh341.11): readings need their own provider key
// and they have none yet, and their library is empty.
const NEW_READER = { ...READER_A, needs_provider_key: true };

const SESSIONS = {
  "reader-a": READER_A,
  "reader-new": NEW_READER,
};

// Reader A again, but the library's list answers with one of the acceptance
// matrix's common states (#416), so a server render of `/` shows that state:
// the session ended between whoami and the list (401), an inactive account
// (403), the expected-tenant pin missed (412), or the backend down (503); or
// with no rows at all (#417), for "No readings yet.".
const SCENARIO_SESSIONS = {
  "reader-empty": LIST_SCENARIOS.empty,
  "reader-expired": LIST_SCENARIOS.expired,
  "reader-forbidden": LIST_SCENARIOS.forbidden,
  "reader-mismatch": LIST_SCENARIOS.mismatch,
  "reader-outage": LIST_SCENARIOS.outage,
  "reader-new": LIST_SCENARIOS.empty,
};

function sessionKeyOf(cookie) {
  const match = /(?:^|;\s*)(?:__Host-session|e2e-session)=([^;]+)/.exec(cookie ?? "");
  return match ? match[1] : undefined;
}

function sessionOf(cookie) {
  const key = sessionKeyOf(cookie);
  if (key === undefined) return undefined;
  return SESSIONS[key] ?? (key in SCENARIO_SESSIONS ? READER_A : undefined);
}

const LIBRARY_ITEMS = libraryItems(pack.list_index.items);

export class FrontendReads extends WorkerEntrypoint {
  async whoami({ cookie }) {
    const identity = sessionOf(cookie);
    return identity ? { status: 200, body: identity } : { status: 401, body: { error: "unauthorized" } };
  }

  async list({ cookie, q, tag, offset }) {
    if (!sessionOf(cookie)) return { status: 401, body: { error: "unauthorized" } };
    const scenario = SCENARIO_SESSIONS[sessionKeyOf(cookie)];
    if (scenario) return scenario;
    return { status: 200, body: libraryPage(LIBRARY_ITEMS, { q, tag, offset }) };
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
