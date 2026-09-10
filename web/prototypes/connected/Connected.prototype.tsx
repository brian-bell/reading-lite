import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ConnectedPrototype } from "./ConnectedPrototype";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});
afterEach(cleanup);

it("opens directly to Connected's library without the comparison interface", () => {
  render(<ConnectedPrototype/>);
  expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
  expect(screen.getByTestId("prototype-surface")).toHaveAttribute("data-direction", "connected");
  expect(window.location.hash).toBe("#/library");
  expect(screen.queryByRole("navigation", { name: "Design directions" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review & choose" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Compare the tasks" })).not.toBeInTheDocument();
});

it("keeps reading, connection, return, and home navigation within the dedicated routes", async () => {
  window.location.hash = "#/reading/attention";
  const user = userEvent.setup(); render(<ConnectedPrototype/>);
  await user.click(screen.getByRole("tab", { name: "Source" }));
  expect(screen.getByRole("heading", { name: "Somewhere to return" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Read connection: Libraries are gardens, not warehouses" }));
  await waitFor(() => expect(window.location.hash).toBe("#/reading/gardens?from=attention"));
  expect(screen.getByText(/You followed a connection from/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Return to previous reading" }));
  await waitFor(() => expect(window.location.hash).toBe("#/reading/attention"));
  await user.click(screen.getByRole("link", { name: "Reading Lite home" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#/library");
});

it("retains capture, completion, and provider setup in the dedicated prototype", async () => {
  const user = userEvent.setup(); render(<ConnectedPrototype/>);
  await user.click(screen.getByRole("button", { name: "Save reading", exact: true }));
  expect(window.location.hash).toBe("#/capture");
  await user.click(screen.getByRole("button", { name: "Save URL" }));
  expect(await screen.findByRole("heading", { name: "Preparing your reading" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#/status/capture-1");
  await user.click(screen.getByRole("button", { name: "Check status" }));
  await user.click(screen.getByRole("button", { name: "Open reading" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Making room for slow work" })).toBeInTheDocument();
  expect(window.location.hash).toBe("#/reading/capture-1");
  await user.click(screen.getByRole("button", { name: "Provider", exact: true }));
  expect(window.location.hash).toBe("#/provider");
  expect(screen.getByLabelText("API key")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Explore sample library" }));
  expect(await screen.findByRole("searchbox", { name: "Search library" })).toBeInTheDocument();
});

it("keeps the phone, theme, and edge-state controls available", async () => {
  const user = userEvent.setup(); render(<ConnectedPrototype/>);
  await user.click(screen.getByRole("button", { name: "Phone layout" }));
  await user.click(screen.getByRole("button", { name: "Dark theme" }));
  await user.selectOptions(screen.getByLabelText("Sample scenario"), "source");
  expect(await screen.findByRole("heading", { name: "Source text is unavailable" })).toBeInTheDocument();
  expect(screen.getByTestId("prototype-stage")).toHaveClass("phone");
  expect(screen.getByTestId("prototype-surface")).toHaveAttribute("data-theme", "dark");
  expect(window.location.hash).toBe("#/reading/unavailable");
});

it("normalizes old comparison links and cannot switch to another design", async () => {
  window.location.hash = "#/workbench/reading/long-title";
  const user = userEvent.setup(); render(<ConnectedPrototype/>);
  expect(screen.getByRole("heading", { level: 1, name: /^What we lose/ })).toBeInTheDocument();
  expect(screen.getByTestId("prototype-surface")).toHaveAttribute("data-direction", "connected");
  expect(window.location.hash).toBe("#/reading/long-title");
  await user.click(screen.getByRole("link", { name: "Reading Lite home" }));
  window.location.hash = "#/connected/review";
  await waitFor(() => expect(window.location.hash).toBe("#/library"));
  expect(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "Editorial reader" })).not.toBeInTheDocument();
});
