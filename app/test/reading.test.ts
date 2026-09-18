import { describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { ApiError } from "../src/api/errors";
import {
  expectedLayoutOf,
  readReadingFromBackend,
  readingFromResponse,
  type Reading,
} from "../src/reading";
import type { BackendReads } from "../src/server/backend-reads";
import type { Identity } from "../src/identity";

// The seam between the backend's answer and the page: which statuses are a
// state the reader sees, which ones throw, and what the server render forwards.

const READY: Reading = { id: "rd_1", url: "https://example.com/a", status: "ready" };

const identity: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
};

describe("readingFromResponse", () => {
  it("passes a reading through", () => {
    expect(readingFromResponse(200, READY)).toEqual({ state: "ready", reading: READY });
  });

  // A manifest keeps parsing as fields come and go; only id, url and status are
  // load-bearing here, so an old manifest is still a readable page.
  it("accepts a manifest carrying only the fields the page depends on", () => {
    const sparse = { id: "rd_1", url: "https://example.com/a", status: "ready" };
    expect(readingFromResponse(200, sparse)).toEqual({ state: "ready", reading: sparse });
  });

  it("rejects a 200 that is not a reading", () => {
    for (const body of [null, "a reading", {}, { id: "rd_1", url: "https://e.com/a", status: "finished" }]) {
      expect(() => readingFromResponse(200, body)).toThrow(ApiError);
    }
  });

  // The projection (#371, from the #390 review thread): every body the fixture
  // pack serves is a reading, including the old manifest and the one whose
  // tensions are null.
  it("accepts every fixture-pack body", () => {
    for (const fixture of pack.fixtures) {
      const body = pack.readings[fixture.id as keyof typeof pack.readings];
      expect(readingFromResponse(200, body).state, fixture.name).toBe("ready");
    }
  });

  it("normalises a null field to an absent one", () => {
    const result = readingFromResponse(200, { ...READY, tensions: null, tags: null });
    expect(result).toEqual({ state: "ready", reading: READY });
    expect(result.state === "ready" ? result.reading.tensions : "kept").toBeUndefined();
  });

  it("reads an optional source_date and treats null as absent", () => {
    const dated = readingFromResponse(200, { ...READY, source_date: "2024-03-15" });
    expect(dated.state === "ready" && dated.reading.source_date).toBe("2024-03-15");
    const cleared = readingFromResponse(200, { ...READY, source_date: null });
    expect(cleared).toEqual({ state: "ready", reading: READY });
  });

  it("reads keywords, people, and organizations for the Details section", () => {
    const result = readingFromResponse(200, pack.readings.rd_FXATTENT01);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.reading.keywords?.length).toBeGreaterThan(0);
    expect(result.reading.people?.length).toBeGreaterThan(0);
    expect(result.reading.orgs).toEqual([]);
  });

  it("carries fields this app never reads through untouched", () => {
    const result = readingFromResponse(200, { ...READY, url_hash: "abc", usage: { tokens: 1 } });
    expect(result.state === "ready" && result.reading).toMatchObject({ url_hash: "abc", usage: { tokens: 1 } });
  });

  // A malformed field the page reads is the documented unexpected-body error,
  // not a crash in a component.
  it("rejects a reading whose read fields are malformed", () => {
    const malformed = [
      { ...READY, title: { text: "not a string" } },
      { ...READY, active_attempt: { status: "running" } },
      { ...READY, error: { code: "X" } },
      { ...READY, connections: [{ id: "rd_2" }] },
      { ...READY, tensions: [{ id: "rd_2", kind: "contradicts" }] },
      { ...READY, relationship_targets: { rd_2: { url: "https://e.com/b" } } },
    ];
    for (const body of malformed) {
      const error = catchError(() => readingFromResponse(200, body));
      expect(error, JSON.stringify(body)).toBeInstanceOf(ApiError);
      expect((error as Error).message).toBe("reading returned an unexpected body");
    }
  });

  // A stage, trigger, or attempt status the backend adds later must not turn
  // the page into an error either: the status card degrades to the raw name.
  it("keeps an unknown stage or trigger rather than rejecting the reading", () => {
    const body = {
      ...READY,
      last_attempt: { id: "at_1", trigger: "backfill", status: "succeeded", stage: "judge_tensions", started_at: "2026-09-09T03:07:00.000Z" },
      error: { code: "X", message: "why", stage: "judge_tensions" },
    };
    expect(readingFromResponse(200, body)).toEqual({ state: "ready", reading: body });
  });

  // A tension kind the backend adds later has no label yet, but it must not
  // turn the page into an error.
  it("keeps an unknown tension kind rather than rejecting the reading", () => {
    const body = {
      ...READY,
      tensions: [{ id: "rd_2", kind: "echoes", reason: "why", computed_at: "2026-09-09T03:07:00.000Z" }],
    };
    expect(readingFromResponse(200, body)).toEqual({ state: "ready", reading: body });
  });

  it("turns the statuses with a page of their own into states", () => {
    expect(readingFromResponse(404, { error: "not found" })).toEqual({ state: "not-found" });
    expect(readingFromResponse(403, { error: "forbidden" })).toEqual({ state: "forbidden" });
    expect(readingFromResponse(412, { error: "mismatch", acting_tenant: "usr_b" })).toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
  });

  it("survives a 412 that names no acting tenant", () => {
    expect(readingFromResponse(412, {})).toEqual({ state: "account-changed", acting_tenant: undefined });
  });

  // 401 drives the shell's expired-session page through isUnauthorized, so it
  // has to reach the QueryCache as an error rather than settle as data.
  it("throws a 401 so the session-ended machinery sees it", () => {
    const error = catchError(() => readingFromResponse(401, { error: "unauthorized" }));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it("throws anything unexpected, keeping the backend's message", () => {
    const error = catchError(() => readingFromResponse(502, { error: "upstream exploded" }));
    expect((error as ApiError).status).toBe(502);
    expect((error as Error).message).toBe("upstream exploded");
  });

  it("falls back to the status when the body carries no message", () => {
    expect(catchError(() => readingFromResponse(500, "<html>"))).toMatchObject({
      message: "reading returned 500",
    });
  });
});

describe("expectedLayoutOf", () => {
  it("names the tenant on the tenant data plane, and the global layout off it", () => {
    expect(expectedLayoutOf(identity)).toBe("usr_a");
    expect(expectedLayoutOf({ ...identity, tenant_data_plane: false })).toBe("global");
  });

  it("pins nothing without an identity", () => {
    expect(expectedLayoutOf(null)).toBeUndefined();
    expect(expectedLayoutOf(undefined)).toBeUndefined();
  });
});

describe("readReadingFromBackend", () => {
  type ReadingInput = Parameters<BackendReads["reading"]>[0];

  function backendReturning(result: { status: number; body: unknown }) {
    return {
      whoami: vi.fn(),
      reading: vi.fn(async (_input: ReadingInput) => result),
      list: vi.fn(),
    } satisfies BackendReads;
  }

  const request = new Request("https://app.example/readings/rd_1", {
    headers: { cookie: "__Host-session=abc" },
  });

  it("forwards this request's cookie and host, the id, and the pin", async () => {
    const backend = backendReturning({ status: 200, body: READY });
    await readReadingFromBackend(backend, request, "rd_1", "usr_a");

    expect(backend.reading).toHaveBeenCalledWith({
      cookie: "__Host-session=abc",
      host: "app.example",
      id: "rd_1",
      expectedTenant: "usr_a",
    });
  });

  // The entrypoint's input schema is strict, so an absent pin must be absent,
  // not an explicit undefined.
  it("omits the pin entirely when there is none", async () => {
    const backend = backendReturning({ status: 200, body: READY });
    await readReadingFromBackend(backend, request, "rd_1", undefined);

    expect(backend.reading.mock.calls[0]![0]).not.toHaveProperty("expectedTenant");
  });

  it("maps the entrypoint's result the same way the browser maps a response", async () => {
    const backend = backendReturning({ status: 404, body: { error: "not found" } });
    await expect(readReadingFromBackend(backend, request, "rd_1", undefined)).resolves.toEqual({
      state: "not-found",
    });
  });

  // A binding that throws is the backend being unreachable, which is the
  // retryable server-error state — not a missing reading.
  it("turns an unreachable binding into an error", async () => {
    const backend = {
      whoami: vi.fn(),
      reading: vi.fn(async (_input: ReadingInput) => {
        throw new Error("binding is down");
      }),
      list: vi.fn(),
    } satisfies BackendReads;

    await expect(readReadingFromBackend(backend, request, "rd_1", undefined)).rejects.toThrow(/binding is down/);
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}
