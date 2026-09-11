// Search parameters stay plain strings, as in the current SPA's URLs
// (acceptance matrix: `?q=&tag=&offset=`, `?next=`, `?step_up=1`). The router's
// default handling decodes `step_up=1` as a number and writes a string "1"
// back as `step_up=%221%22`, which redirects server renders to that spelling.
// Routes validate and convert their own parameters.

function parseSearch(searchStr: string): Record<string, string> {
  const search: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(searchStr)) {
    // First value wins, as URLSearchParams.get does.
    if (!(name in search)) search[name] = value;
  }
  return search;
}

function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    params.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  const searchStr = params.toString();
  return searchStr === "" ? "" : `?${searchStr}`;
}

export const plainSearch = { parseSearch, stringifySearch };
