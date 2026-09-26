import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningOver } from "../e2e/running-over";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { MARKDOWN_IMPORT_BUDGET_BYTES } from "../src/markdown-import-limit";
import type { Reading } from "../src/reading";
import { SECOND, advance, json, openReadingPage, settle as settleRounds, type Answer } from "./reading-page-harness";

// Import a copy on the reading page (#411; acceptance matrix, Actions:
// Reprocess from Markdown; Reading detail: Failed, Source unavailable,
// Imported Markdown; Capture: Markdown too large). The browser branch of the
// reading query (reading-page-harness.tsx), with a stubbed backend that
// answers reads, the Source view's content, and the reprocess separately.
// What the outcomes say is owned by test/reading-reprocess.test.tsx and the
// shared notice (CaptureNotice.tsx); here, that the dialog keeps what was
// pasted through them. The modal itself — Escape, the focus trap, and focus
// returning however it closes — is the browser's, owned by
// e2e/specs/reprocess.spec.ts.

vi.mock("@tanstack/react-start", async (importOriginal) =>
  (await import("./start-client-mock")).clientBranchOnly(importOriginal),
);
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => new Request("https://app.example/") }));

const readings = pack.readings as Record<string, Reading>;
const FAILED = readings.rd_FXERR00001!;
const UNAVAILABLE_SOURCE = readings.rd_FXRAWSRC01!;
const IMPORTED = readings.rd_FXMDPAGE01!;

/** Each read takes the next answer, the last one repeating; the same for reprocesses. */
let reads: Answer[];
let reprocesses: Answer[];
let reprocessRequests: Request[];

const started = (id: string) => json({ id, status: "pending", poll: `/api/readings/${id}`, attempt_id: "at_NEW01" }, 202);

function next(answers: Answer[]): Answer {
  return answers.length > 1 ? answers.shift()! : answers[0]!;
}

const settle = () => settleRounds(5);

async function openReading(reading: Reading, view?: "source") {
  reads = [json(reading)];
  return openReadingPage(reading, view ? `?view=${view}` : "");
}

function button(name: string) {
  return screen.getByRole("button", { name });
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector("dialog");
}

function inDialog() {
  return within(dialog()!);
}

function field(name: string): HTMLInputElement | HTMLTextAreaElement {
  return inDialog().getByLabelText(name, { exact: false }) as HTMLInputElement | HTMLTextAreaElement;
}

function type(name: string, value: string) {
  fireEvent.change(field(name), { target: { value } });
}

async function openImport() {
  fireEvent.click(button("Import a copy"));
  await settle();
  expect(dialog()).toHaveAttribute("open");
}

async function importCopy(markdown = "# A copy\n\nThe whole article.", title = "") {
  await openImport();
  type("Title", title);
  type("Markdown", markdown);
  fireEvent.click(inDialog().getByRole("button", { name: "Import" }));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  reads = [json(FAILED)];
  reprocesses = [started(FAILED.id)];
  reprocessRequests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (request.method === "POST") {
        reprocessRequests.push(request);
        return next(reprocesses)();
      }
      if (new URL(request.url).pathname.endsWith("/content")) {
        return new Response("# Captured\n\nThe captured article.", { headers: { "content-type": "text/markdown" } });
      }
      return next(reads)();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("where Import a copy is offered", () => {
  // A failed reading has no Source view: `?view=source` is its Summary, with the card.
  const offeredIn = (reading: Reading, view: "summary" | "source"): boolean =>
    reading.status === "failed" || (reading.id === UNAVAILABLE_SOURCE.id && view === "source");

  // Every fixture in both views: a failed reading beside Retry, and the
  // unavailable source's Source view — and nowhere else, not on a ready
  // reading whose source was captured.
  it.each(
    pack.fixtures.flatMap((fixture) =>
      (["summary", "source"] as const).map((view) => ({ name: fixture.name, view, reading: readings[fixture.id]! })),
    ),
  )("$name, $view view", async ({ reading, view }) => {
    await openReading(reading, view === "source" ? "source" : undefined);
    await settle();
    expect(screen.queryAllByRole("button", { name: "Import a copy" })).toHaveLength(offeredIn(reading, view) ? 1 : 0);
  });

  it("sits beside Retry on a failed reading", async () => {
    await openReading(FAILED);
    const card = screen.getByRole("region", { name: "Processing status" });
    expect(within(card).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Import a copy" })).toBeInTheDocument();
  });
});

describe("the form", () => {
  it("prefills the reading's URL, read-only, and starts in the Markdown", async () => {
    await openReading(FAILED);
    await openImport();

    expect(inDialog().getByRole("heading", { name: "Import a copy" })).toBeInTheDocument();
    expect(field("Source URL")).toHaveValue(FAILED.url);
    expect(field("Source URL")).toHaveAttribute("readonly");
    expect(field("Markdown")).toHaveFocus();
  });

  it("sends the Markdown and title as the reprocess's Markdown source, never force", async () => {
    await openReading(FAILED);
    await importCopy("# A copy\n\nThe whole article.", "  A copy  ");

    expect(reprocessRequests).toHaveLength(1);
    const request = reprocessRequests[0]!;
    expect(new URL(request.url).pathname).toBe(`/api/readings/${FAILED.id}/reprocess`);
    expect(await request.json()).toEqual({
      source: { kind: "markdown", markdown: "# A copy\n\nThe whole article.", title: "A copy" },
    });
  });

  it("asks for the Markdown before sending anything", async () => {
    await openReading(FAILED);
    await importCopy("   ");

    expect(reprocessRequests).toEqual([]);
    expect(inDialog().getByText("Paste the Markdown you want to import.")).toBeInTheDocument();
    expect(field("Markdown")).toHaveFocus();
  });

  // Acceptance matrix, Capture: Markdown too large. The backend's own answer
  // would be a 503 after it had written, so the form never sends it.
  it("refuses a paste too large for the queue, names the limit, and keeps the text", async () => {
    await openReading(FAILED);
    const tooLarge = "a".repeat(MARKDOWN_IMPORT_BUDGET_BYTES);
    await importCopy(tooLarge);

    expect(reprocessRequests).toEqual([]);
    expect(inDialog().getByText(/limited to 128 KB/)).toBeInTheDocument();
    expect(field("Markdown")).toHaveValue(tooLarge);
    expect(field("Markdown")).toHaveFocus();
  });

  it("sends one request however many times Import is pressed while the first is in flight", async () => {
    await openReading(FAILED);
    let answer!: (response: Response) => void;
    reprocesses = [() => new Promise<Response>((resolve) => (answer = resolve))];
    await importCopy();

    const submit = inDialog().getByRole("button", { name: "Import" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await settle();
    expect(reprocessRequests).toHaveLength(1);

    answer(Response.json({ id: FAILED.id, attempt_id: "at_NEW01" }, { status: 202 }));
    await settle();
    expect(reprocessRequests).toHaveLength(1);
  });

  it("sends nothing when the reader cancels", async () => {
    await openReading(FAILED);
    await openImport();
    type("Markdown", "# A copy");
    fireEvent.click(inDialog().getByRole("button", { name: "Cancel" }));
    await settle();

    expect(dialog()).toBeNull();
    expect(reprocessRequests).toEqual([]);
  });
});

describe("an import that starts", () => {
  // The acceptance criterion's stubbed sequence of manifests: failed, then
  // pending with the import running, then ready from the Markdown.
  it("closes, watches the attempt, and ends with the reading ready from Imported Markdown", async () => {
    await openReading(FAILED);
    reprocesses = [started(FAILED.id)];
    reads = [json(runningOver(FAILED, "prepare_markdown"))];
    await importCopy();

    expect(dialog()).toBeNull();
    const card = screen.getByRole("region", { name: "Processing status" });
    expect(within(card).getByText("This reading is still being processed.")).toBeInTheDocument();
    // The card's one control now, where Import a copy's focus comes back to.
    expect(button("Check status")).toHaveFocus();

    reads = [json({ ...IMPORTED, id: FAILED.id, url: FAILED.url })];
    await advance(3 * SECOND);
    expect(screen.queryByRole("region", { name: "Processing status" })).toBeNull();
    expect(screen.getByText("Imported Markdown")).toBeInTheDocument();
  });

  // A failed import restores the ready manifest it ran over: its summary, its
  // connections, and its source type, with the failure on `last_attempt`.
  it("leaves the prior ready reading and its source type when it fails", async () => {
    await openReading(UNAVAILABLE_SOURCE, "source");
    reprocesses = [started(UNAVAILABLE_SOURCE.id)];
    reads = [json(runningOver(UNAVAILABLE_SOURCE, "prepare_markdown"))];
    await importCopy();

    expect(dialog()).toBeNull();
    expect(screen.getByText("This reading is being processed again.")).toBeInTheDocument();
    // Kept, and not pressable, while the attempt runs.
    expect(button("Import a copy")).toHaveAttribute("aria-disabled", "true");

    reads = [
      json({
        ...UNAVAILABLE_SOURCE,
        last_attempt: { ...readings.rd_FXREPROC01!.last_attempt!, id: "at_NEW01" },
      }),
    ];
    await advance(3 * SECOND);
    expect(screen.getByText("Reprocess failed. The previous version is still here.")).toBeInTheDocument();
    expect(screen.queryByText("Imported Markdown")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    await settle();
    expect(screen.getByText(UNAVAILABLE_SOURCE.tldr!)).toBeInTheDocument();
  });
});

describe("an import that does not start", () => {
  it.each([
    {
      name: "an attempt already running",
      answer: json({ error: "reading already has an active attempt" }, 409),
      sentence: "This reading is already processing.",
      tryAgain: false,
    },
    {
      name: "a quota",
      answer: json({ error: "hourly reading quota exceeded", code: "quota_exhausted", limit: "hourly" }, 429),
      sentence: "You've reached the hourly reading limit.",
      tryAgain: true,
    },
    {
      name: "a queue that is not there",
      answer: json({ error: "queue unbound" }, 503),
      sentence: "Importing is unavailable right now.",
      tryAgain: true,
    },
  ])("says so for $name in the dialog, and keeps what was pasted", async ({ answer, sentence, tryAgain }) => {
    await openReading(FAILED);
    reprocesses = [answer];
    await importCopy("# A copy", "A title");

    expect(dialog()).toHaveAttribute("open");
    expect(inDialog().getByText(sentence, { selector: ".offline-notice-text" })).toBeInTheDocument();
    expect(inDialog().getByRole("status")).toHaveTextContent(sentence);
    expect(field("Markdown")).toHaveValue("# A copy");
    expect(field("Title")).toHaveValue("A title");
    expect(inDialog().queryAllByRole("button", { name: "Try again" })).toHaveLength(tryAgain ? 1 : 0);
  });

  it("sends the same copy again on Try again", async () => {
    await openReading(FAILED);
    reprocesses = [json({ error: "queue unbound" }, 503), started(FAILED.id)];
    reads = [json(runningOver(FAILED))];
    await importCopy("# A copy", "A title");

    fireEvent.click(inDialog().getByRole("button", { name: "Try again" }));
    await settle();

    expect(reprocessRequests).toHaveLength(2);
    expect(await reprocessRequests[1]!.json()).toEqual({
      source: { kind: "markdown", markdown: "# A copy", title: "A title" },
    });
    expect(dialog()).toBeNull();
  });

  it("leaves the page's own notices to the page's own actions", async () => {
    await openReading(FAILED);
    reprocesses = [json({ error: "queue unbound" }, 503)];
    await importCopy();
    fireEvent.click(inDialog().getByRole("button", { name: "Cancel" }));
    await settle();

    expect(screen.queryByText("Importing is unavailable right now.")).toBeNull();
  });
});

// A Markdown reading whose stored copy is gone cannot be reprocessed from it
// (409 `markdown content not available`); a new copy is the way on.
describe("a Markdown reading whose copy is gone", () => {
  it("offers Import a copy from the refusal", async () => {
    await openReading(IMPORTED);
    reprocesses = [json({ error: "markdown content not available" }, 409)];
    fireEvent.click(button("Reprocess"));
    await settle();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Reprocess" }));
    await settle();

    expect(
      screen.getByText("The Markdown this reading was imported from is no longer available.", {
        selector: ".offline-notice-text",
      }),
    ).toBeInTheDocument();
    await openImport();
    expect(field("Source URL")).toHaveValue(IMPORTED.url);
  });
});
