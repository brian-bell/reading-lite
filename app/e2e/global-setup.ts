import path from "node:path";
import { startHarness } from "./harness";

// Starts the server the whole run shares and returns Playwright's teardown.
export default async function globalSetup(): Promise<() => Promise<void>> {
  return startHarness(path.join(import.meta.dirname, ".."));
}
