// Stand-in for the backend's FrontendReads entrypoint (the repo root's
// src/frontend-reads.ts) in the browser-evidence suite: same method names and
// result shape, canned identities per session cookie, and reading detail, the
// library's list and the relationship graph served from the fixture pack
// snapshot (#366 via scripts/emit-app-fixture-pack.ts), with generated rows
// past the list for paging.
// Plain JavaScript so the app's TypeScript config doesn't need the full Workers
// runtime types, as smoke/backend-stub.js is.
//
// Unlike the smoke stub this one accepts any host: Playwright drives the
// harness on 127.0.0.1, and host forwarding already has its evidence in
// smoke/worker.test.ts.
import { WorkerEntrypoint } from "cloudflare:workers";
import pack from "./fixtures/fixture-pack.json";
import { libraryItems, libraryPage } from "./library-page.js";

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

// The new reader's library is empty.
const EMPTY_LIBRARY = { readings: [], limit: 20, offset: 0, has_more: false };

function sessionKeyOf(cookie) {
  const match = /(?:^|;\s*)(?:__Host-session|e2e-session)=([^;]+)/.exec(cookie ?? "");
  return match ? match[1] : undefined;
}

function sessionOf(cookie) {
  const key = sessionKeyOf(cookie);
  if (key === undefined) return undefined;
  return SESSIONS[key];
}

const LIBRARY_ITEMS = libraryItems(pack.list_index.items);

export class FrontendReads extends WorkerEntrypoint {
  async whoami({ cookie }) {
    const identity = sessionOf(cookie);
    return identity ? { status: 200, body: identity } : { status: 401, body: { error: "unauthorized" } };
  }

  async list({ cookie, q, tag, offset }) {
    const identity = sessionOf(cookie);
    if (!identity) return { status: 401, body: { error: "unauthorized" } };
    if (identity === NEW_READER) return { status: 200, body: EMPTY_LIBRARY };
    return { status: 200, body: libraryPage(LIBRARY_ITEMS, { q, tag, offset }) };
  }

  // The /threads pages' server render: the pack's graph, or the new reader's
  // empty one.
  async relationships({ cookie }) {
    const identity = sessionOf(cookie);
    if (!identity) return { status: 401, body: { error: "unauthorized" } };
    if (identity === NEW_READER) return { status: 200, body: { readings: [], relationships: [] } };
    return { status: 200, body: pack.relationships };
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
