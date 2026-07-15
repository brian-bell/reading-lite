// Lazy seam: playwright is a devDependency whose browsers are installed
// only on the home box (npx playwright install chromium). Import cost is
// deferred until the headless tier runs; nothing under src/ may import this.
export async function loadPlaywright() {
  return await import("playwright");
}
