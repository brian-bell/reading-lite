import { QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { AppFrame } from "../src/components/AppFrame";
import { LibraryHome } from "../src/components/LibraryPage";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { LibraryRow } from "../src/library";
import { loadLibraryPage } from "../src/library-query";
import { libraryParamsOf, validateLibrarySearch } from "../src/library-search";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";

// The status refresh contract's Library rule (acceptance matrix, Status
// refresh contract, acceptance checks 10 and 11), with fake timers and a
// stubbed `fetch`. As test/reading-refresh.test.tsx does for the reading page,
// this resolves the isomorphic loader and query to their browser functions,
// the branch that refreshes. The schedule's backoff ceiling is pinned in
// test/status-refresh.test.ts, and the watch's offline and reconnect handling
// on the reading page.

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createIsomorphicFn: () => {
    let client: (...args: unknown[]) => unknown = () => {
      throw new Error("no client branch");
    };
    const fn = (...args: unknown[]) => client(...args);
    fn.server = () => fn;
    fn.client = (implementation: typeof client) => {
      client = implementation;
      return fn;
    };
    return fn;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => new Request("https://app.example/") }));

const rows = pack.list_index.items as LibraryRow[];
const PENDING = rows.find((row) => row.id === "rd_FXPENDNG01")!;
const READY = rows.find((row) => row.id === "rd_FXATTENT01")!;
const FAILED = rows.find((row) => row.id === "rd_FXERR00001")!;
const REPROCESS_FAILED = rows.find((row) => row.id === "rd_FXREPROC01")!;
const RUNNING_ON_READY: LibraryRow = {
  ...READY,
  active_attempt: {
    id: "at_FXRUNNING1",
    trigger: "reprocess",
    status: "running",
    started_at: "2026-09-11T10:00:00.000Z",
  },
};
const { active_attempt: _finished, ...pendingWithoutAttempt } = PENDING;
const FINISHED: LibraryRow = { ...pendingWithoutAttempt, status: "ready" };

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

type Answer = () => Response | Promise<Response>;

/** The stubbed list endpoint: each request takes the next answer, the last one repeating. */
let answers: Answer[];
/** When each list request after the page load was made, relative to it. */
let requestTimes: number[];
let requests: Request[];
let mountedAt: number;

function answerWith(...next: Answer[]) {
  answers = next;
}

const json =
  (body: unknown, status = 200): Answer =>
  () =>
    Response.json(body, { status });
const page = (...readings: LibraryRow[]) => json({ readings, limit: 20, offset: 0, has_more: false });
const networkFailure: Answer = () => {
  throw new TypeError("Failed to fetch");
};

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame theme="system" onThemeChange={() => undefined}>
      <Outlet />
    </AppFrame>
  ),
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateLibrarySearch,
  loaderDeps: ({ search }) => libraryParamsOf(search),
  loader: ({ context, deps }) => loadLibraryPage(context.queryClient, deps),
  component: function LibraryRoute() {
    return <LibraryHome search={libraryRoute.useSearch()} />;
  },
});
const elsewhereRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/elsewhere",
  component: () => <p>Elsewhere</p>,
});
const routeTree = rootRoute.addChildren([libraryRoute, elsewhereRoute]);

async function settle(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openLibrary(first: Answer) {
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, reader);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  const repeating = answers;
  answerWith(first, ...repeating);
  const view = render(<RouterProvider router={router} />);
  await settle(5);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Library");
  // The page load's own request is not one of the watch's.
  mountedAt = Date.now();
  requestTimes = [];
  answerWith(...repeating);
  return { ...view, queryClient, router };
}

async function navigate(router: Awaited<ReturnType<typeof openLibrary>>["router"], href: string) {
  await act(async () => {
    await router.navigate({ href });
  });
  await settle(3);
}

const stoppedNote = () => screen.queryByText("Couldn't check status.");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  answers = [page(PENDING, READY)];
  requestTimes = [];
  requests = [];
  mountedAt = Date.now();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname !== "/api/readings") return Response.json(reader);
      requests.push(request);
      requestTimes.push(Date.now() - mountedAt);
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      return answer();
    }),
  );
});

afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("which pages refresh", () => {
  // Check 10.
  it.each([
    { name: "a pending row", active: PENDING },
    { name: "a ready row with a running attempt", active: RUNNING_ON_READY },
  ])("asks for the page every 15 s while it has $name", async ({ active }) => {
    answerWith(page(active, READY));
    await openLibrary(page(active, READY));
    await advance(50 * SECOND);

    expect(requestTimes).toEqual([15 * SECOND, 30 * SECOND, 45 * SECOND]);
  });

  // Check 11.
  it.each([
    { name: "ready readings", readings: [READY] },
    { name: "failed readings", readings: [FAILED] },
    { name: "a reading whose reprocess finished failing", readings: [REPROCESS_FAILED] },
  ])("never asks for a page of $name", async ({ readings }) => {
    answerWith(page(...readings));
    await openLibrary(page(...readings));
    await advance(17 * MINUTE);

    expect(requestTimes).toEqual([]);
  });

  it("stops once no row on the page is active, updating the badge in place", async () => {
    await openLibrary(page(PENDING, READY));
    const link = screen.getByRole("link", { name: PENDING.url });
    link.focus();
    expect(screen.getByText("Processing")).toBeInTheDocument();

    answerWith(page(FINISHED, READY));
    await advance(15 * SECOND);
    expect(screen.queryByText("Processing")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(link);
    expect(screen.queryAllByRole("status").every((region) => region.textContent === "")).toBe(true);

    await advance(5 * MINUTE);
    expect(requestTimes).toEqual([15 * SECOND]);
  });

  it("stops asking at 16 minutes, saying nothing about it", async () => {
    await openLibrary(page(PENDING, READY));
    await advance(30 * MINUTE);

    expect(requestTimes.at(-1)).toBe(15 * MINUTE + 45 * SECOND);
    expect(stoppedNote()).not.toBeInTheDocument();
  });
});

describe("failed checks", () => {
  it.each([
    { name: "network failures", failure: networkFailure },
    { name: "server errors", failure: json({ error: "boom" }, 503) },
  ])("stops after three consecutive $name, keeping the rows with a quiet note", async ({ failure }) => {
    await openLibrary(page(PENDING, READY));
    answerWith(failure);
    await advance(3 * MINUTE);

    expect(requestTimes).toHaveLength(3);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Library");
    expect(screen.getByRole("link", { name: PENDING.url })).toBeInTheDocument();
    expect(stoppedNote()).toBeInTheDocument();
    expect(stoppedNote()!.closest("[role=status]")).toBeNull();
    await advance(20 * MINUTE);
    expect(requestTimes).toHaveLength(3);
  });

  it("drops the note once a later read of the page answers", async () => {
    const { queryClient } = await openLibrary(page(PENDING, READY));
    answerWith(networkFailure);
    await advance(3 * MINUTE);
    expect(stoppedNote()).toBeInTheDocument();

    // A save elsewhere invalidates the library.
    answerWith(page(PENDING, READY));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["library"] });
    });
    await settle(2);
    expect(stoppedNote()).not.toBeInTheDocument();
    await advance(5 * MINUTE);
    expect(requestTimes).toHaveLength(4);
  });

  // A failed read with no check to blame keeps the library's own states.
  it.each([
    { name: "a page with no active row", readings: [READY], before: 0 },
    { name: "a page past the cap", readings: [PENDING, READY], before: 17 * MINUTE },
  ])("shows a failed read of $name as a server error", async ({ readings, before }) => {
    answerWith(page(...readings));
    const { queryClient } = await openLibrary(page(...readings));
    await advance(before);
    answerWith(json({ error: "backend unavailable" }, 503));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["library"] });
    });
    await settle(2);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side.");
  });

  it("shows a read that failed offline as offline at once, even while checking", async () => {
    const { queryClient } = await openLibrary(page(PENDING, READY));
    answerWith(() => {
      onlineManager.setOnline(false);
      throw new TypeError("Failed to fetch");
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["library"] });
    });
    await settle(2);

    expect(screen.getByText("You're offline. Check your connection and try again.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: PENDING.url })).toBeInTheDocument();
  });
});

describe("a new watch", () => {
  it("makes no timed requests for a filtered page with no active row", async () => {
    const { router } = await openLibrary(page(PENDING, READY));
    answerWith(page(READY));
    await navigate(router, "/?tag=design");
    const afterNavigation = requestTimes.length;
    await advance(5 * MINUTE);

    expect(requestTimes).toHaveLength(afterNavigation);
  });

  it("starts on another page after the failure stop", async () => {
    const { router } = await openLibrary(page(PENDING, READY));
    answerWith(networkFailure);
    await advance(3 * MINUTE);
    expect(stoppedNote()).toBeInTheDocument();

    answerWith(page(PENDING, READY));
    await navigate(router, "/?offset=20");
    expect(stoppedNote()).not.toBeInTheDocument();
    const navigatedAt = requestTimes.at(-1)!;
    await advance(31 * SECOND);
    expect(requestTimes.slice(-2)).toEqual([navigatedAt + 15 * SECOND, navigatedAt + 30 * SECOND]);
  });

  it("starts again on a reload after the cap", async () => {
    const first = await openLibrary(page(PENDING, READY));
    await advance(17 * MINUTE);
    first.unmount();

    await openLibrary(page(PENDING, READY));
    await advance(16 * SECOND);
    expect(requestTimes).toEqual([15 * SECOND]);
  });

  it("cancels the timer and the request in flight when the reader leaves", async () => {
    const { router } = await openLibrary(page(PENDING, READY));
    answerWith(() => new Promise<Response>(() => undefined));
    await advance(15 * SECOND);
    expect(requests.at(-1)!.signal.aborted).toBe(false);

    await navigate(router, "/elsewhere");
    expect(screen.getByText("Elsewhere")).toBeInTheDocument();
    expect(requests.at(-1)!.signal.aborted).toBe(true);
    await advance(5 * MINUTE);
    expect(requestTimes).toEqual([15 * SECOND]);
  });
});
