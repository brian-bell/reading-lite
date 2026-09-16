import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 25's built-in Web Storage globals shadow jsdom's, and without
// --localstorage-file they have no methods. Use jsdom's, as on Node 22.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
for (const name of ["localStorage", "sessionStorage"] as const) {
  if (dom && typeof globalThis[name]?.getItem !== "function") {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
}

afterEach(() => {
  cleanup();
});

// jsdom has HTMLDialogElement but no modal behaviour. The stub opens and
// closes it and fires `close`, which is all a component test can observe;
// Escape, the focus trap, and inertness are the browser's, and are owned by
// the Playwright suite (e2e/specs/reprocess.spec.ts).
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
