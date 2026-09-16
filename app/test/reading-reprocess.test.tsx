import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { AppFrame } from "../src/components/AppFrame";
import { ReadingPage } from "../src/components/ReadingPage";
import { createQueryClient, hrefOnScreen } from "../src/auth/session";
import { whoamiQueryKey, type Identity } from "../src/identity";
import type { Reading } from "../src/reading";
import { readingQueryOptions } from "../src/reading-query";
import type { RouterContext } from "../src/router";
import { plainSearch } from "../src/search";

// Retry and Reprocess on the reading page (#410; acceptance matrix, Actions:
// Reprocess, Reading detail, Capture: Already processing; status refresh
// acceptance check 9). The browser branch of the reading query, as in
// test/reading-refresh.test.tsx, with a stubbed backend that answers reads and
// the reprocess separately. The modal itself — Escape, the focus trap, and
// focus returning — is the browser's and is owned by
// e2e/specs/reprocess.spec.ts.

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

const readings = pack.readings as Record<string, Reading>;
const READY = readings.rd_FXATTENT01!;
const REPROCESS_FAILED = readings.rd_FXREPROC01!;
const FAILED_FIXTURES = pack.fixtures
  .filter((fixture) => readings[fixture.id]?.status === "failed")
  .map((fixture) => ({ name: fixture.name, reading: readings[fixture.id]! }));

const reader: Identity = {
  tenant_id: "usr_a",
  user_id: "usr_a",
  principal: "session",
  tenant_data_plane: true,
  email: "a@example.com",
  csrf_token: "csrf-a",
};

const SECOND = 1_000;

type Answer = () => Response | Promise<Response>;

/** Each read takes the next answer, the last one repeating; the same for reprocesses. */
let reads: Answer[];
let reprocesses: Answer[];
let readRequests: Request[];
let reprocessRequests: Request[];

const json = (body: unknown, status = 200): Answer => () => Response.json(body, { status });
const started = (id: string) => json({ id, status: "pending", poll: `/api/readings/${id}`, attempt_id: "at_NEW01" }, 202);

function next(answers: Answer[]): Answer {
  return answers.length > 1 ? answers.shift()! : answers[0]!;
}

/** The reading with a new reprocess attempt running over it. */
function runningOver(reading: Reading, stage = "fetch_source"): Reading {
  return {
    ...reading,
    ...(reading.status === "failed" ? { status: "pending", error: undefined } : {}),
    active_attempt: { id: "at_NEW01", trigger: "reprocess", status: "running", stage, started_at: "2026-09-16T10:00:00.000Z" },
  };
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame theme="system" onThemeChange={() => undefined}>
      <Outlet />
    </AppFrame>
  ),
});
const readingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/readings/$id",
  loader: ({ context, params }) =>
    context.queryClient.prefetchQuery(readingQueryOptions(context.queryClient, params.id, reader)),
  component: function ReadingRoute() {
    const { id } = readingRoute.useParams();
    return <ReadingPage id={id} />;
  },
});
const leftRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>Elsewhere</p> });
const routeTree = rootRoute.addChildren([readingRoute, leftRoute]);

async function settle() {
  for (let i = 0; i < 5; i++) {
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

async function openReading(reading: Reading) {
  reads = [json(reading)];
  const queryClient = createQueryClient(() => hrefOnScreen(router));
  queryClient.setQueryData(whoamiQueryKey, reader);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    ...plainSearch,
    history: createMemoryHistory({ initialEntries: [`/readings/${reading.id}`] }),
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  render(<RouterProvider router={router} />);
  await settle();
  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  readRequests = [];
  return { queryClient, router };
}

function button(name: string) {
  return screen.getByRole("button", { name });
}

function statusCard() {
  return screen.getByRole("region", { name: "Processing status" });
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector("dialog");
}

function politeRegion(): string {
  return screen
    .getAllByRole("status")
    .map((region) => region.textContent ?? "")
    .join("");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  reads = [json(READY)];
  reprocesses = [started(READY.id)];
  readRequests = [];
  reprocessRequests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (request.method === "POST") {
        reprocessRequests.push(request);
        return next(reprocesses)();
      }
      readRequests.push(request);
      return next(reads)();
    }),
  );
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Retry on a failed reading", () => {
  it.each(FAILED_FIXTURES)("reprocesses $name at once and watches the new attempt", async ({ reading }) => {
    await openReading(reading);
    reprocesses = [started(reading.id)];
    reads = [json(runningOver(reading))];

    const retry = button("Retry");
    retry.focus();
    fireEvent.click(retry);
    await settle();

    expect(dialog()).toBeNull();
    expect(reprocessRequests).toHaveLength(1);
    expect(within(statusCard()).getByText("This reading is still being processed.")).toBeInTheDocument();
    // The card's one control is the same button, now Check status, so focus stays on it.
    expect(button("Check status")).toBe(retry);
    expect(retry).toHaveFocus();
  });

  // Check 9: the watch that starts is the new attempt's, from the fast interval.
  it("starts a watch for the attempt the retry started", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    reprocesses = [started(failed.id)];
    reads = [json(runningOver(failed))];

    fireEvent.click(button("Retry"));
    await settle();
    const afterRetry = readRequests.length;
    await advance(6 * SECOND);
    expect(readRequests.length - afterRetry).toBe(2);
  });

  it("sends one request however many times it is pressed while the first is in flight", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    let answer!: (response: Response) => void;
    reprocesses = [() => new Promise<Response>((resolve) => (answer = resolve))];
    reads = [json(runningOver(failed))];

    fireEvent.click(button("Retry"));
    await settle();
    expect(button("Retry")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button("Retry"));
    fireEvent.click(button("Retry"));
    await settle();
    expect(reprocessRequests).toHaveLength(1);

    answer(Response.json({ id: failed.id, attempt_id: "at_NEW01" }, { status: 202 }));
    await settle();
    expect(reprocessRequests).toHaveLength(1);
  });

  // The invalidation is the mutation's own, so it still runs once the page is gone.
  it("refreshes the reading when the reader left before the answer came", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    const { router, queryClient } = await openReading(failed);
    let answer!: (response: Response) => void;
    reprocesses = [() => new Promise<Response>((resolve) => (answer = resolve))];

    fireEvent.click(button("Retry"));
    await settle();
    await act(() => router.navigate({ to: "/" }));
    await settle();

    reads = [json(runningOver(failed))];
    answer(Response.json({ id: failed.id, attempt_id: "at_NEW01" }, { status: 202 }));
    await settle();
    expect(queryClient.getQueryState(["reading", failed.id])?.isInvalidated).toBe(true);

    await act(() => router.navigate({ to: "/readings/$id", params: { id: failed.id } }));
    await settle();
    expect(within(statusCard()).getByText("This reading is still being processed.")).toBeInTheDocument();
  });

  it("does not send it again when the network comes back", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    reprocesses = [
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    onlineManager.setOnline(false);

    fireEvent.click(button("Retry"));
    await settle();
    expect(screen.getByText("You're offline. Check your connection and try again.", { selector: ".offline-notice-text" })).toBeInTheDocument();

    onlineManager.setOnline(true);
    await advance(30 * SECOND);
    expect(reprocessRequests).toHaveLength(1);
  });
});

describe("Reprocess on a ready reading", () => {
  it("asks first, and Cancel sends nothing", async () => {
    await openReading(READY);
    fireEvent.click(button("Reprocess"));
    await settle();

    expect(dialog()).toHaveAttribute("open");
    expect(within(dialog()!).getByRole("heading", { name: "Reprocess this reading?" })).toBeInTheDocument();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Cancel" }));
    await settle();

    expect(dialog()).toBeNull();
    expect(reprocessRequests).toEqual([]);
  });

  // The acceptance criterion's stubbed sequence of manifests: ready, then
  // ready with the reprocess running, then ready with it failed.
  it("keeps the prior summary through the reprocess and after it fails", async () => {
    const reprocessing = runningOver(REPROCESS_FAILED);
    const restored = REPROCESS_FAILED;
    const prior: Reading = { ...REPROCESS_FAILED, last_attempt: undefined };
    await openReading(prior);
    reprocesses = [started(prior.id)];
    reads = [json(reprocessing)];

    fireEvent.click(button("Reprocess"));
    await settle();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Reprocess" }));
    await settle();

    expect(reprocessRequests).toHaveLength(1);
    expect(within(statusCard()).getByText("This reading is being processed again.")).toBeInTheDocument();
    expect(screen.getByText(prior.tldr!)).toBeInTheDocument();
    // Kept, and not pressable, while the attempt runs.
    expect(button("Reprocess")).toHaveAttribute("aria-disabled", "true");

    reads = [json(restored)];
    await advance(3 * SECOND);
    expect(within(statusCard()).getByText("Reprocess failed. The previous version is still here.")).toBeInTheDocument();
    expect(within(statusCard()).getByText("The page couldn't be fetched.")).toBeInTheDocument();
    expect(screen.getByText(prior.tldr!)).toBeInTheDocument();
    expect(within(statusCard()).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("asks again before Try again sends another", async () => {
    await openReading(READY);
    reprocesses = [json({ error: "queue unbound" }, 503)];
    fireEvent.click(button("Reprocess"));
    await settle();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Reprocess" }));
    await settle();

    fireEvent.click(button("Try again"));
    await settle();
    expect(dialog()).toHaveAttribute("open");
    expect(reprocessRequests).toHaveLength(1);
  });
});

describe("a reprocess that does not start", () => {
  // Copy for each 429 window is owned by test/save-page.test.tsx; one of each
  // refusal is enough to show the reading page renders it and keeps the card.
  // The 409, whose refetch shows the running attempt, has its own tests below.
  it.each([
    {
      name: "a quota",
      answer: json({ error: "hourly reading quota exceeded", code: "quota_exhausted", limit: "hourly" }, 429),
      sentence: "You've reached the hourly reading limit.",
      action: "Try again",
    },
    {
      name: "a queue that is not there",
      answer: json({ error: "queue unbound" }, 503),
      sentence: "Reprocessing is unavailable right now.",
      action: "Try again",
    },
  ])("says so for $name, and leaves the reading as it was", async ({ answer, sentence, action }) => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    reprocesses = [answer];

    fireEvent.click(button("Retry"));
    await settle();

    expect(screen.getByText(sentence, { selector: ".offline-notice-text" })).toBeInTheDocument();
    expect(politeRegion()).toContain(sentence);
    expect(button(action)).toBeInTheDocument();
    expect(button("Retry")).toBeInTheDocument();
    // The reading is read again after every answer.
    expect(readRequests).toHaveLength(1);
  });

  // The refusal is of the write; the reading's own read, refetched after every
  // answer, decides whether the page is still the reader's.
  it("says a 403 on the write in a notice and keeps the reading", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    reprocesses = [json({ error: "forbidden" }, 403)];
    // whoami for the 403's second read, then the reading.
    reads = [json(reader), json(failed)];

    fireEvent.click(button("Retry"));
    await settle();
    expect(
      screen.getByText("You don't have permission to reprocess this reading.", { selector: ".offline-notice-text" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(failed.url);
  });

  // The notice describes the attempt the 409 found; once the watch sees that
  // attempt end, the card says what happened and the notice would contradict it.
  it("takes the already-processing notice away when that attempt ends, and says the outcome", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    reprocesses = [json({ error: "reading already has an active attempt" }, 409)];
    reads = [json(runningOver(failed))];

    fireEvent.click(button("Retry"));
    await settle();
    expect(screen.getByText("This reading is already processing.", { selector: ".offline-notice-text" })).toBeInTheDocument();
    expect(politeRegion()).toBe("This reading is already processing.");
    expect(button("Open reading")).toBeInTheDocument();

    reads = [json({ ...READY, id: failed.id, url: failed.url })];
    await advance(3 * SECOND);
    await settle();
    expect(screen.queryByText("This reading is already processing.", { selector: ".offline-notice-text" })).toBeNull();
    expect(politeRegion()).toBe("Processing finished. This reading is ready.");
  });

  // A failed refetch leaves the reading from before the request cached, which
  // is not proof the attempt the 409 named has ended.
  it("keeps the already-processing notice when the refetch after it fails", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    reprocesses = [json({ error: "reading already has an active attempt" }, 409)];
    reads = [json({ error: "backend unavailable" }, 503)];

    fireEvent.click(button("Retry"));
    await settle();
    expect(screen.getByText("This reading is already processing.", { selector: ".offline-notice-text" })).toBeInTheDocument();
  });

  it("keeps focus on the card's control when Retry finds an attempt already running", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    await openReading(failed);
    reprocesses = [json({ error: "reading already has an active attempt" }, 409)];
    reads = [json(runningOver(failed))];

    const retry = button("Retry");
    retry.focus();
    fireEvent.click(retry);
    await settle();
    expect(button("Check status")).toHaveFocus();
  });

});

describe("Try again after a refused Reprocess", () => {
  async function refusedReprocess(readAfter: Reading = READY) {
    await openReading(READY);
    reprocesses = [json({ error: "queue unbound" }, 503)];
    reads = [json(readAfter)];
    fireEvent.click(button("Reprocess"));
    await settle();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Reprocess" }));
    await settle();
  }

  it("asks again, and gives focus back to Try again when the reader cancels", async () => {
    await refusedReprocess();
    const tryAgain = button("Try again");
    tryAgain.focus();
    fireEvent.click(tryAgain);
    await settle();
    expect(dialog()).toHaveAttribute("open");
    expect(reprocessRequests).toHaveLength(1);

    fireEvent.click(within(dialog()!).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(tryAgain).toHaveFocus();
  });

  it("asks nothing while an attempt started elsewhere is running", async () => {
    await refusedReprocess(runningOver(READY));
    fireEvent.click(button("Try again"));
    await settle();
    expect(dialog()).toBeNull();
  });
});

describe("one reading at a time", () => {
  const OTHER = readings.rd_FXGARDEN01!;

  it("does not carry a refusal to another reading, or show it again on coming back", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    const { router } = await openReading(failed);
    reprocesses = [json({ error: "queue unbound" }, 503)];
    fireEvent.click(button("Retry"));
    await settle();
    expect(button("Try again")).toBeInTheDocument();

    reads = [json(OTHER)];
    await act(() => router.navigate({ to: "/readings/$id", params: { id: OTHER.id } }));
    await settle();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(OTHER.title!);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    reads = [json(failed)];
    await act(() => router.history.back());
    await settle();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(failed.url);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  // Browser Back is outside the modal's inert page: the confirmation must not
  // stay open over the next reading, where Confirm would start its paid run.
  it("closes an open confirmation when the reader goes to another reading", async () => {
    const { router } = await openReading(READY);
    fireEvent.click(button("Reprocess"));
    await settle();
    expect(dialog()).toHaveAttribute("open");

    reads = [json(OTHER)];
    await act(() => router.navigate({ to: "/readings/$id", params: { id: OTHER.id } }));
    await settle();
    expect(dialog()).toBeNull();
    expect(reprocessRequests).toEqual([]);
  });

  it("gives focus to the page when a confirmation is removed while open", async () => {
    const { queryClient } = await openReading(READY);
    fireEvent.click(button("Reprocess"));
    await settle();

    reads = [json({ error: "not found" }, 404)];
    await act(() => queryClient.invalidateQueries({ queryKey: ["reading", READY.id] }));
    await settle();
    expect(dialog()).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });
});

describe("the polite region", () => {
  // A retry refused, then one that fails the way the last attempt did: the
  // second failure is a new outcome and is said, although its words are not new.
  it("says an outcome again after a notice, even in the same words", async () => {
    const failed = FAILED_FIXTURES[0]!.reading;
    const pending = runningOver(failed);
    reads = [json(pending)];
    await openReading(pending);
    reads = [json(failed)];
    await advance(3 * SECOND);
    const outcome = politeRegion();
    expect(outcome).toMatch(/^Processing failed\. /);

    reprocesses = [json({ error: "queue unbound" }, 503), started(failed.id)];
    fireEvent.click(button("Retry"));
    await settle();
    expect(politeRegion()).toContain("Reprocessing is unavailable right now.");

    reads = [json({ ...pending, active_attempt: { ...pending.active_attempt!, id: "at_NEW02" } }), json(failed)];
    fireEvent.click(button("Try again"));
    await settle();
    await advance(3 * SECOND);
    expect(politeRegion()).toBe(outcome);
  });
});
