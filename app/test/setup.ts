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
