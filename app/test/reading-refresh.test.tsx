import { focusManager, onlineManager } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { stageLabel } from "../src/components/ReadingStatusCard";
import { ProcessingStageSchema, type Reading } from "../src/reading";
import { diagnosticsQueryKey } from "../src/reading-diagnostics";
import { sourceQueryKey } from "../src/reading-source";
import { MINUTE, SECOND, advance, json, openReadingPage, politeRegion, settle, type Answer } from "./reading-page-harness";

// The status refresh contract on the reading page (acceptance matrix, Status
// refresh contract, acceptance checks 1–9, 11, 12), with fake timers and a
// stubbed `fetch`. This drives the browser branch of the reading query — the
// one that refreshes — by resolving the isomorphic loader to its client
// function (start-client-mock.ts), which test/reading-detail.test.tsx cannot
// do without the Start compiler.

vi.mock("@tanstack/react-start", async (importOriginal) =>
  (await import("./start-client-mock")).clientBranchOnly(importOriginal),
);
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => new Request("https://app.example/") }));

const readings = pack.readings as Record<string, Reading>;
const PENDING_ID = "rd_FXPENDNG01";
const PENDING = readings[PENDING_ID]!;
const READY = readings.rd_FXATTENT01!;
const FAILED = readings.rd_FXERR00001!;
const REPROCESS_FAILED = readings.rd_FXREPROC01!;

/** The stubbed backend: each request takes the next answer, the last one repeating. */
let answers: Answer[];
/** When each request after the first page load was made, relative to mount. */
let requestTimes: number[];
let mountedAt: number;
let requests: Request[];

function answerWith(...next: Answer[]) {
  answers = next;
}

const pending = (reading: Reading = PENDING) => json(reading);
const networkFailure: Answer = () => {
  throw new TypeError("Failed to fetch");
};

async function openReading(reading: Reading) {
  const opened = await openReadingPage(reading);
  // The page load's own request is not one of the watch's.
  mountedAt = Date.now();
  requestTimes = [];
  return opened;
}

const announcement = politeRegion;

function checkStatus() {
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  answers = [pending()];
  requestTimes = [];
  requests = [];
  mountedAt = Date.now();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
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

describe("the schedule", () => {
  // Check 1.
  it("asks every 3 s for 30 s, then every 5 s until 2 min, then every 15 s", async () => {
    await openReading(PENDING);
    await advance(2 * MINUTE + 15 * SECOND);

    const threes = Array.from({ length: 10 }, (_, i) => (i + 1) * 3 * SECOND);
    const fives = Array.from({ length: 18 }, (_, i) => 30 * SECOND + (i + 1) * 5 * SECOND);
    expect(requestTimes).toEqual([...threes, ...fives, 2 * MINUTE + 15 * SECOND]);
  });

  // Checks 2 and 12. A batch-owned attempt at `summarize` is exempt from the
  // backend's pending TTL, so it is the one that really does outlive the cap.
  it.each([
    { name: "an ordinary pending reading", reading: PENDING },
    {
      name: "a batch-owned pending reading",
      reading: {
        ...PENDING,
        active_attempt: { ...PENDING.active_attempt!, id: "batch_FX01", trigger: "import", stage: "summarize" },
      },
    },
  ])("stops asking at 16 minutes for $name, leaving the manual check", async ({ reading }) => {
    answerWith(json(reading));
    await openReading(reading);
    await advance(16 * MINUTE);
    expect(requestTimes.at(-1)).toBeLessThan(16 * MINUTE);
    expect(screen.getByText("Still processing.")).toBeInTheDocument();

    const automatic = requestTimes.length;
    await advance(30 * MINUTE);
    expect(requestTimes).toHaveLength(automatic);

    checkStatus();
    await settle();
    expect(requestTimes).toHaveLength(automatic + 1);
    await advance(5 * MINUTE);
    expect(requestTimes).toHaveLength(automatic + 1);
  });

  // Check 11.
  it("never asks about a reading that is not being processed", async () => {
    answerWith(json(READY));
    await openReading(READY);
    await advance(5 * MINUTE);

    expect(requestTimes).toEqual([]);
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
  });
});

describe("stopping", () => {
  // Check 3. The attempt rewrote the reading's content and logged itself, so
  // a Source view or Details already read are stale too (#443 review).
  it("stops at ready, announces it once, and refreshes the library, Source, and Diagnostics", async () => {
    const { queryClient } = await openReading(PENDING);
    queryClient.setQueryData(["library", { offset: 0 }], { rows: [] });
    queryClient.setQueryData(sourceQueryKey(PENDING_ID), { state: "unavailable" });
    queryClient.setQueryData(diagnosticsQueryKey(PENDING_ID), { state: "unavailable" });
    answerWith(pending(), json({ ...PENDING, status: "ready", active_attempt: null, title: "Done" }));
    await advance(6 * SECOND);

    expect(announcement()).toBe("Processing finished. This reading is ready.");
    expect(queryClient.getQueryState(["library", { offset: 0 }])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sourceQueryKey(PENDING_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(diagnosticsQueryKey(PENDING_ID))?.isInvalidated).toBe(true);
    expect(screen.queryByLabelText("Processing status")).not.toBeInTheDocument();
    await advance(5 * MINUTE);
    expect(requestTimes).toEqual([3 * SECOND, 6 * SECOND]);
    expect(announcement()).toBe("Processing finished. This reading is ready.");
  });

  // The route component is reused across readings, so an outcome said on one
  // visit must not be said again by coming back to the same reading.
  it("does not announce a finished reading again after leaving and coming back", async () => {
    const { router } = await openReading(PENDING);
    const done = { ...PENDING, status: "ready", active_attempt: null, title: "Done" };
    answerWith(json(done));
    await advance(3 * SECOND);
    expect(announcement()).toBe("Processing finished. This reading is ready.");

    answerWith(json(READY));
    await act(async () => {
      await router.navigate({ to: "/readings/$id", params: { id: READY.id } });
    });
    for (let i = 0; i < 3; i++) await settle();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(READY.title!);
    answerWith(json(done));
    await act(async () => {
      await router.navigate({ to: "/readings/$id", params: { id: PENDING_ID } });
    });
    for (let i = 0; i < 3; i++) await settle();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Done");
    expect(announcement()).toBe("");
  });

  // Check 4.
  it("stops at failed and shows the failure category", async () => {
    await openReading(PENDING);
    answerWith(json(FAILED));
    await advance(3 * SECOND);

    expect(screen.getByText("The page couldn't be fetched.")).toBeInTheDocument();
    expect(announcement()).toBe("Processing failed. The page couldn't be fetched.");
    await advance(5 * MINUTE);
    expect(requestTimes).toEqual([3 * SECOND]);
  });

  // A failed reprocess restores the ready manifest and records the failure on
  // `last_attempt`, so `status: "ready"` alone would announce a success.
  it("announces a failed reprocess as a failure", async () => {
    const reprocessing: Reading = {
      ...REPROCESS_FAILED,
      active_attempt: { ...REPROCESS_FAILED.last_attempt!, status: "running", finished_at: undefined, error: undefined },
    };
    answerWith(json(reprocessing));
    await openReading(reprocessing);
    answerWith(json(REPROCESS_FAILED));
    await advance(3 * SECOND);

    expect(announcement()).toMatch(/^Processing again failed; the previous version is still here\. /);
    expect(requestTimes).toEqual([3 * SECOND]);
  });

  // Check 5. A 401 hands the page to the shell, whose expired-session page
  // unmounts it and so stops the checks: that page is pinned in
  // test/reading-detail.test.tsx, and the stop in the browser suite
  // (e2e/specs/reading-refresh.spec.ts), where the shell re-renders as it does
  // not under these fake timers.
  it("hands a 401 from a check to the shell", async () => {
    const { queryClient } = await openReading(PENDING);
    answerWith(json({ error: "unauthorized" }, 401));
    await advance(3 * SECOND);

    expect(queryClient.getQueryData(["session-ended"])).toBe(`/readings/${PENDING_ID}`);
  });

  it.each([
    { status: 403, heading: "You don't have access to this." },
    { status: 404, heading: "This reading isn't in your library." },
    { status: 412, heading: "This tab is signed in to a different account than the page expects." },
  ])("stops at $status and shows its state", async ({ status, heading }) => {
    await openReading(PENDING);
    answerWith(json({ error: "no" }, status));
    await advance(3 * SECOND);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
    await advance(5 * MINUTE);
    expect(requestTimes).toEqual([3 * SECOND]);
  });

  // Check 8.
  it("cancels the timer and the request in flight when the reader leaves", async () => {
    const { router } = await openReading(PENDING);
    answerWith(() => new Promise<Response>(() => undefined));
    await advance(3 * SECOND);
    expect(requests.at(-1)!.signal.aborted).toBe(false);

    await act(async () => {
      await router.navigate({ to: "/" });
    });
    await settle();
    expect(screen.getByText("Elsewhere")).toBeInTheDocument();
    expect(requests.at(-1)!.signal.aborted).toBe(true);
    await advance(5 * MINUTE);
    expect(requestTimes).toEqual([3 * SECOND]);
  });
});

describe("a hidden tab", () => {
  // Check 6.
  it("asks nothing while hidden, then asks at once on becoming visible", async () => {
    await openReading(PENDING);
    act(() => focusManager.setFocused(false));
    await advance(40 * SECOND);
    expect(requestTimes).toEqual([]);

    act(() => focusManager.setFocused(true));
    await settle();
    expect(requestTimes).toEqual([40 * SECOND]);
    await advance(5 * SECOND);
    expect(requestTimes).toEqual([40 * SECOND, 45 * SECOND]);
  });

  // Offline, Query pauses the automatic check it was due to make and resumes
  // it on reconnect whatever `refetchOnReconnect` says; past the cap it must
  // not go out.
  it("drops an automatic check held offline once the cap passes", async () => {
    await openReading(PENDING);
    await advance(15 * MINUTE + 40 * SECOND);
    const before = requestTimes.length;
    act(() => onlineManager.setOnline(false));
    await advance(10 * MINUTE);
    expect(requestTimes).toHaveLength(before);
    expect(screen.getByText("Still processing.")).toBeInTheDocument();

    act(() => onlineManager.setOnline(true));
    await advance(MINUTE);
    expect(requestTimes).toHaveLength(before);
  });

  // Hidden time counts toward the cap, and a stopped watch stays stopped.
  it("does not ask on becoming visible after the cap", async () => {
    await openReading(PENDING);
    act(() => focusManager.setFocused(false));
    await advance(17 * MINUTE);
    act(() => focusManager.setFocused(true));
    await settle();

    expect(requestTimes).toEqual([]);
    expect(screen.getByText("Still processing.")).toBeInTheDocument();
  });
});

describe("failed checks", () => {
  // Check 7.
  it.each([
    { name: "network failures", failure: networkFailure },
    { name: "server errors", failure: json({ error: "boom" }, 503) },
  ])("stops after three consecutive $name, keeping the reading on screen", async ({ failure }) => {
    await openReading(PENDING);
    answerWith(failure);
    await advance(3 * SECOND + 6 * SECOND + 12 * SECOND);

    expect(requestTimes).toEqual([3 * SECOND, 9 * SECOND, 21 * SECOND]);
    expect(screen.getByText("Couldn't check status.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(PENDING.url);
    await advance(20 * MINUTE);
    expect(requestTimes).toHaveLength(3);

    // Coming back online is not a way around the stop.
    act(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(requestTimes).toHaveLength(3);
  });

  it("says a failed manual check failed, even after the cap", async () => {
    await openReading(PENDING);
    await advance(17 * MINUTE);
    expect(screen.getByText("Still processing.")).toBeInTheDocument();

    answerWith(json({ error: "unavailable" }, 503));
    checkStatus();
    await settle();
    expect(screen.getByText("Couldn't check status.")).toBeInTheDocument();
    expect(screen.queryByText("Still processing.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(PENDING.url);
  });

  it("starts counting again after a check that answers", async () => {
    await openReading(PENDING);
    answerWith(networkFailure, pending(), networkFailure, networkFailure, pending());
    await advance(30 * SECOND);

    // Backoff doubles the 3 s interval per failure and resets on the answer.
    expect(requestTimes).toEqual([3 * SECOND, 9 * SECOND, 12 * SECOND, 18 * SECOND, 30 * SECOND]);
    expect(screen.queryByText("Couldn't check status.")).not.toBeInTheDocument();
  });
});

describe("a new attempt", () => {
  // Check 9: a reprocess or retry shows up as a new attempt id.
  it("starts a new watch, from the fast interval, even after the cap", async () => {
    await openReading(PENDING);
    await advance(17 * MINUTE);
    const beforeManual = requestTimes.length;

    const retried = { ...PENDING, active_attempt: { ...PENDING.active_attempt!, id: "at_FXRETRY01" } };
    answerWith(json(retried));
    checkStatus();
    await settle();
    expect(screen.queryByText("Still processing.")).not.toBeInTheDocument();

    await advance(6 * SECOND);
    expect(requestTimes.slice(beforeManual)).toEqual([17 * MINUTE, 17 * MINUTE + 3 * SECOND, 17 * MINUTE + 6 * SECOND]);
  });
});

describe("stageLabel", () => {
  it.each(ProcessingStageSchema.options.map((stage) => ({ stage })))("labels $stage coarsely", ({ stage }) => {
    const index = ProcessingStageSchema.options.indexOf(stage);
    const expected =
      index <= ProcessingStageSchema.options.indexOf("write_extracted")
        ? "Fetching"
        : index <= ProcessingStageSchema.options.indexOf("embed_summary")
          ? "Analyzing"
          : "Publishing";
    expect(stageLabel(stage)).toBe(expected);
  });

  it.each([undefined, "a_stage_added_later"])("falls back to Processing for %s", (stage) => {
    expect(stageLabel(stage)).toBe("Processing");
  });
});
