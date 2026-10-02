import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

function open(hash: string) {
  window.location.hash = hash;
  return render(<App />);
}

beforeEach(() => {
  window.location.hash = "";
});

describe("home", () => {
  it("opens on the desk", () => {
    open("");
    expect(screen.getByRole("heading", { level: 1, name: "Desk" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Desk" })).toHaveAttribute("aria-current", "page");
  });
});

describe("reading", () => {
  it("carries the thread strip, mentions, revisit, more like this, and the desk toggle together", () => {
    open("#/reading/what-a-commonplace-book-is-for");
    expect(screen.getByRole("navigation", { name: "Thread" })).toHaveTextContent("In Knowledge · 2 of 3");
    expect(within(screen.getByRole("list", { name: "Mentions" })).getByRole("link", { name: "Ines Halvorsen" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Worth revisiting" })).toHaveTextContent("On marginalia");
    expect(screen.getByRole("region", { name: "More like this" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Put on desk" })).toBeInTheDocument();
  });

  it("follows a connection and comes back along the trail", async () => {
    const user = userEvent.setup();
    open("#/reading/a-quieter-internet");
    expect(screen.getByText("Reading removed")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Libraries are gardens, not warehouses" }));
    expect(screen.getByRole("heading", { level: 1, name: "Libraries are gardens, not warehouses" })).toBeInTheDocument();
    expect(screen.getByText(/From/)).toHaveTextContent("A quieter internet is a choice we can make");
    await user.click(screen.getByRole("button", { name: /Back to A quieter internet/ }));
    expect(screen.getByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeInTheDocument();
  });

  it("recovers a failed reading from the status card", async () => {
    const user = userEvent.setup();
    open("#/reading/interface-budgets");
    expect(screen.getByText("Your OpenAI key needs replacing.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Replace key" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("status")).toHaveTextContent("Fetching");
  });
});

describe("read-time state", () => {
  it("keeps a reading whose reprocess failed readable, with the card and badge but no Retry", async () => {
    const user = userEvent.setup();
    open("#/reading/reading-as-conversation");
    expect(screen.getByText(/^Reprocess failed · The page couldn't be fetched\./)).toBeInTheDocument();
    expect(screen.getByText(/A book read twice is a conversation/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reprocess" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Library" }));
    const card = screen.getByRole("link", { name: "Reading as conversation" }).closest("li")!;
    expect(within(card).getByText("Reprocess failed")).toBeInTheDocument();
  });

  it("surfaces a stalled capture as stopped, and a retry starts a fresh attempt", async () => {
    const user = userEvent.setup();
    open("#/reading/the-cost-of-convenience");
    expect(screen.getByText("Processing stopped before finishing.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("status")).toHaveTextContent("Fetching");
    await user.click(screen.getByRole("link", { name: "Desk" }));
    expect(screen.getByRole("region", { name: "Processing" })).toHaveTextContent("The cost of convenience");
  });

  it("lists both on the desk under Needs you", () => {
    open("#/desk");
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Reprocess failed · The page couldn't be fetched."),
      expect.stringContaining("Processing stopped before finishing."),
      expect.stringContaining("Your OpenAI key needs replacing."),
    ]);
  });
});

describe("threads", () => {
  it("lists threads with the tensions on the same page, and opens a thread in order", async () => {
    const user = userEvent.setup();
    open("#/threads");
    const list = screen.getByRole("list", { name: "Threads" });
    expect(within(list).getAllByRole("listitem").filter((li) => li.className === "thread-card")).toHaveLength(2);
    expect(within(screen.getByRole("list", { name: "Tensions" })).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getByRole("link", { name: "Attention" }));
    const rail = screen.getByRole("list", { name: "Readings in Attention" });
    const titles = within(rail).getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles[0]).toBe("Reading on paper, again");
    expect(titles.at(-1)).toBe("The tab that never closes");
  });
});

describe("desk", () => {
  it("walks a session from the desk through done and next", async () => {
    const user = userEvent.setup();
    open("#/desk");
    const onDesk = screen.getByRole("region", { name: "On your desk" });
    await user.click(within(onDesk).getByRole("link", { name: "Start" }));
    expect(screen.getByRole("heading", { level: 1, name: "The tab that never closes" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Session" })).toHaveTextContent("1 of 2");
    await user.click(screen.getByRole("button", { name: "Done, next" }));
    expect(screen.getByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done, clear the desk" }));
    expect(screen.getByRole("heading", { level: 1, name: "Desk" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "On your desk" })).toHaveTextContent("Nothing yet");
  });

  it("reviews the inbox on the desk: preview, add to the library, discard", async () => {
    const user = userEvent.setup();
    open("#/desk");
    const inbox = screen.getByRole("region", { name: "Inbox" });
    expect(within(inbox).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(inbox).getAllByRole("button", { name: "Preview" })[0]);
    expect(within(inbox).getByText(/One file\. One line per reading/)).toBeInTheDocument();
    await user.click(within(inbox).getAllByRole("button", { name: "Discard" })[1]);
    expect(within(screen.getByRole("region", { name: "Inbox" })).getAllByRole("listitem")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Add to library" }));
    expect(screen.getByRole("heading", { level: 1, name: "How to keep a reading log" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Fetching");
    await user.click(screen.getByRole("link", { name: "Desk" }));
    expect(screen.queryByRole("region", { name: "Inbox" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Processing" })).toHaveTextContent("How to keep a reading log");
  });

  it("takes a new reader from the landing through sign-in, key, and first save", async () => {
    const user = userEvent.setup();
    open("#/desk");
    await user.selectOptions(screen.getByLabelText("Scenario"), "new-reader");
    expect(screen.getByRole("heading", { level: 1, name: /summarizes what you save/ })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "A quieter internet is a choice we can make" }));
    expect(screen.getByText(/A sample reading/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Sign in" }));
    await user.click(screen.getByRole("button", { name: "Email me a link (sample)" }));
    expect(screen.getByRole("heading", { level: 2, name: "Three steps to your first reading" })).toBeInTheDocument();
    expect(screen.getByText("See how a processed reading looks").closest("li")).toHaveClass("onboarding-done");
    expect(screen.getByText("Save a reading")).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "Connect sample key" }));
    await user.click(screen.getByRole("link", { name: "Save a reading" }));
    await user.type(screen.getByLabelText("Article URL"), "https://fieldnotes.example/first");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("heading", { level: 1, name: "First" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check status" }));
    expect(screen.getByText("What this adds")).toBeInTheDocument();
  });
});

describe("catalog", () => {
  it("browses the index, narrows by a person, then asks by meaning from the same page", async () => {
    const user = userEvent.setup();
    open("#/catalog");
    expect(screen.getByRole("heading", { level: 1, name: "Catalog" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "People" })).getAllByRole("listitem")).toHaveLength(6);
    await user.click(screen.getByRole("link", { name: "Hosts" }));
    expect(within(screen.getByRole("list", { name: "Hosts" })).getAllByRole("listitem")).toHaveLength(5);
    await user.click(screen.getByRole("link", { name: "People" }));
    await user.click(screen.getByRole("link", { name: "Mara Ellis" }));
    expect(screen.getByRole("heading", { level: 2, name: "2 readings for Mara Ellis" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Back to the index" }));
    await user.click(screen.getByRole("button", { name: "Meaning" }));
    await user.type(screen.getByLabelText("Search"), "why do I keep saving things I never read");
    await user.click(screen.getByRole("button", { name: "Find" }));
    const results = screen.getByRole("list", { name: "Results" });
    expect(within(results).getAllByRole("listitem")[0]).toHaveTextContent("The tab that never closes");
    expect(within(results).getAllByRole("listitem")[0]).toHaveTextContent("Close");
    await user.click(screen.getByRole("link", { name: "Clear search why do I keep saving things I never read" }));
    expect(screen.getByRole("list", { name: "People" })).toBeInTheDocument();
  });

  it("leads from a reading's mentions into the catalog", async () => {
    const user = userEvent.setup();
    open("#/reading/the-case-for-a-little-friction");
    await user.click(within(screen.getByRole("list", { name: "Mentions" })).getByRole("link", { name: "Leah Chen" }));
    expect(screen.getByRole("heading", { level: 1, name: "Catalog" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "1 reading for Leah Chen" })).toBeInTheDocument();
  });

  it("switches the library to rows", async () => {
    const user = userEvent.setup();
    open("#/library");
    await user.click(screen.getByRole("button", { name: "Rows" }));
    expect(screen.getByRole("list", { name: "Readings" })).toHaveClass("find-results");
  });
});
