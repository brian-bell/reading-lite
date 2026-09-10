import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

beforeEach(() => { window.localStorage.clear(); window.location.hash = "#/editorial/reading/attention"; });
afterEach(cleanup);

for (const direction of ["editorial", "workbench", "connected"]) {
  describe(direction, () => {
    beforeEach(() => { window.location.hash = `#/${direction}/reading/attention`; });
    it("reads the source, follows a connection, and returns with context", async () => {
      const user = userEvent.setup(); render(<App />);
      await user.click(screen.getByRole("tab", { name: "Source" }));
      expect(screen.getByRole("heading", { name: "Somewhere to return" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Read connection: Libraries are gardens, not warehouses" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Libraries are gardens, not warehouses" })).toBeInTheDocument();
      expect(screen.getByText(/You followed a connection from/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Return to previous reading" }));
      expect(await screen.findByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Read tension: The case for a little friction" }));
      expect(await screen.findByRole("heading", { level: 1, name: "The case for a little friction" })).toBeInTheDocument();
      expect(screen.getByText(/You followed a tension from/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Return to previous reading" }));
      expect(await screen.findByRole("heading", { level: 1, name: "A quieter internet is a choice we can make" })).toBeInTheDocument();
    });
    it("filters by text and tag, handles empty results, and preserves filters on return", async () => {
      const user = userEvent.setup(); render(<App />);
      await user.click(screen.getByRole("button", { name: "Library", exact: true }));
      const search = await screen.findByRole("searchbox", { name: "Search library" });
      await user.type(search, "gardens");
      await user.click(screen.getByRole("button", { name: "Filter by Knowledge" }));
      await user.click(screen.getByRole("button", { name: "Open reading: Libraries are gardens, not warehouses" }));
      await user.click(screen.getByRole("button", { name: "Library", exact: true }));
      expect(await screen.findByRole("searchbox")).toHaveValue("gardens");
      await user.clear(screen.getByRole("searchbox"));
      await user.type(screen.getByRole("searchbox"), "no-such-reading");
      expect(screen.getByRole("heading", { name: "No readings found" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(screen.getByRole("searchbox")).toHaveValue("");
    });
    it("simulates a failed URL capture, retries, and opens the recovered reading without network calls", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
      try {
        const user = userEvent.setup(); render(<App />);
        await user.click(screen.getByRole("button", { name: "Save reading", exact: true }));
        await user.selectOptions(await screen.findByLabelText("Preview result"), "source");
        await user.click(screen.getByRole("button", { name: "Save URL" }));
        expect(await screen.findByRole("heading", { name: "Preparing your reading" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Check status" }));
        expect(screen.getByRole("heading", { name: "The source could not be captured" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry sample" }));
        await user.click(screen.getByRole("button", { name: "Check status" }));
        await user.click(screen.getByRole("button", { name: "Open reading" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Making room for slow work" })).toBeInTheDocument();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally { fetchSpy.mockRestore(); }
    });
  });
}

it("provides sparse, unavailable-source, missing-target, pending, and failure scenarios", async () => {
  const user = userEvent.setup(); render(<App />);
  await user.selectOptions(screen.getByLabelText("Sample scenario"), "sparse");
  expect(await screen.findByText("Your library is taking shape")).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Sample scenario"), "source");
  expect(await screen.findByRole("heading", { name: "Source text is unavailable" })).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Sample scenario"), "deleted");
  await user.click(await screen.findByRole("button", { name: "View unavailable connection: Notes on the attention economy" }));
  expect(await screen.findByRole("heading", { name: "This reading is no longer available" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Return to previous reading" }));
  await user.selectOptions(screen.getByLabelText("Sample scenario"), "pending");
  expect(await screen.findByRole("heading", { name: "Preparing your reading" })).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Sample scenario"), "failed");
  expect(await screen.findByRole("heading", { name: "The source could not be captured" })).toBeInTheDocument();
});

it("imports Markdown and keeps the actual supplied text as the sample source", async () => {
  window.location.hash = "#/editorial/capture";
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole("tab", { name: "Markdown" }));
  const input = screen.getByLabelText("Markdown text");
  await user.clear(input); await user.type(input, "# A test reading\n\nThe original sample words.");
  await user.click(screen.getByRole("button", { name: "Import Markdown" }));
  await user.click(await screen.findByRole("button", { name: "Check status" }));
  await user.click(screen.getByRole("button", { name: "Open reading" }));
  await user.click(await screen.findByRole("tab", { name: "Source" }));
  expect(screen.getByText("The original sample words.")).toBeInTheDocument();
});

it("previews provider states and retains library access after removing the sample key", async () => {
  window.location.hash = "#/connected/provider";
  const user = userEvent.setup(); render(<App />);
  expect(screen.getByLabelText("API key")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Connect sample key" }));
  expect(screen.getByRole("status")).toHaveTextContent("Sample key connected");
  await user.click(screen.getByRole("button", { name: "Remove sample key" }));
  expect(screen.getByRole("heading", { name: "Key removed. Your library stays." })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Explore sample library" }));
  expect(await screen.findByRole("searchbox")).toBeInTheDocument();
});

it("switches directions without losing the current reading and exposes phone and dark treatments", async () => {
  window.location.hash = "#/editorial/reading/long-title";
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole("button", { name: "Compare Connected reading" }));
  await waitFor(() => expect(window.location.hash).toContain("/connected/reading/long-title"));
  await user.click(screen.getByRole("button", { name: "Phone layout" }));
  await user.click(screen.getByRole("button", { name: "Dark theme" }));
  expect(screen.getByTestId("prototype-stage")).toHaveClass("phone");
  expect(screen.getByTestId("prototype-surface")).toHaveAttribute("data-theme", "dark");
});

it("records an explicit direction and borrowed elements locally", async () => {
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole("button", { name: "Review & choose" }));
  await user.click(await screen.findByRole("radio", { name: "Connected reading" }));
  await user.type(screen.getByLabelText("Elements to borrow"), "Borrow the editorial source typography.");
  await user.click(screen.getByRole("button", { name: "Save decision locally" }));
  const saved = JSON.parse(window.localStorage.getItem("reading-lite-design-decision-336")!);
  expect(saved).toMatchObject({ direction: "connected", borrow: "Borrow the editorial source typography." });
  cleanup(); render(<App />);
  expect(screen.getByRole("radio", { name: "Connected reading" })).toBeChecked();
  expect(screen.getByLabelText("Elements to borrow")).toHaveValue("Borrow the editorial source typography.");
});

it("switches source tabs with arrow keys and retains focus", async () => {
  const user = userEvent.setup(); render(<App />);
  const summary = screen.getByRole("tab", { name: "Summary" });
  summary.focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Source" })).toHaveFocus();
  expect(screen.getByRole("heading", { name: "Somewhere to return" })).toBeInTheDocument();
  await user.keyboard("{Home}");
  expect(screen.getByRole("tab", { name: "Summary" })).toHaveFocus();
  expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
});

it("returns to the same library page after opening the long-title reading", async () => {
  window.location.hash = "#/workbench/library";
  const user = userEvent.setup(); render(<App />);
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Open reading: What we lose/ }));
  expect(await screen.findByRole("heading", { level: 1, name: /^What we lose/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Library", exact: true }));
  expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
});

for (const [outcome, title, action] of [
  ["credentials", "Your AI key needs attention", "Review provider settings"],
  ["provider", "The AI provider is at its limit", "Review provider settings"],
  ["hosting", "Your reading allowance is used up", "Return to library"],
]) {
  it(`shows actionable ${outcome} failure details`, async () => {
    window.location.hash = "#/connected/capture";
    const user = userEvent.setup(); render(<App />);
    await user.selectOptions(screen.getByLabelText("Preview result"), outcome);
    await user.click(screen.getByRole("button", { name: "Save URL" }));
    await user.click(await screen.findByRole("button", { name: "Check status" }));
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    if (outcome === "hosting") expect(screen.queryByRole("button", { name: "Retry sample" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: action }));
    if (outcome === "hosting") expect(await screen.findByRole("searchbox")).toBeInTheDocument();
    else expect(await screen.findByLabelText("API key")).toBeDisabled();
  });
}

it("renders an unknown direct reading URL as unavailable with a library exit", async () => {
  window.location.hash = "#/connected/reading/does-not-exist";
  const user = userEvent.setup(); render(<App />);
  expect(screen.getByRole("heading", { name: "This reading is no longer available" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Return to library" }));
  expect(await screen.findByRole("searchbox")).toBeInTheDocument();
});
