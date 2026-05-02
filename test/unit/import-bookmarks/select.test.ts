import { describe, expect, it } from "vitest";
import type { Folder, Link } from "../../../scripts/import-bookmarks-lib/parse";
import { collectLinks, selectFolder } from "../../../scripts/import-bookmarks-lib/select";

function link(url: string, title = url): Link {
  return { url, title };
}

const TREE: Folder = {
  name: "",
  folders: [
    {
      name: "Bookmarks Bar",
      folders: [],
      links: [link("https://example.com/bar1")],
    },
    {
      name: "Computing",
      folders: [
        {
          name: "AI",
          folders: [
            {
              name: "MCP",
              folders: [],
              links: [link("https://example.com/mcp1")],
            },
          ],
          links: [link("https://example.com/ai1")],
        },
      ],
      links: [link("https://example.com/c1"), link("https://example.com/c2")],
    },
  ],
  links: [],
};

describe("selectFolder", () => {
  it("resolves a top-level folder by name", () => {
    const f = selectFolder(TREE, "Computing");
    expect(f?.name).toBe("Computing");
    expect(f?.links).toHaveLength(2);
  });

  it("resolves a nested folder via slash-delimited path", () => {
    const f = selectFolder(TREE, "Computing/AI/MCP");
    expect(f?.name).toBe("MCP");
    expect(f?.links.map((l) => l.url)).toEqual(["https://example.com/mcp1"]);
  });

  it("matches case-insensitively", () => {
    expect(selectFolder(TREE, "computing")?.name).toBe("Computing");
    expect(selectFolder(TREE, "COMPUTING/ai/mcp")?.name).toBe("MCP");
  });

  it("trims whitespace around segments", () => {
    expect(selectFolder(TREE, " Computing / AI ")?.name).toBe("AI");
  });

  it("returns null when no folder matches", () => {
    expect(selectFolder(TREE, "Nope")).toBeNull();
    expect(selectFolder(TREE, "Computing/Nope")).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(selectFolder(TREE, "")).toBeNull();
    expect(selectFolder(TREE, "   ")).toBeNull();
  });
});

describe("collectLinks", () => {
  it("flattens links from the folder and all descendants in source order", () => {
    const computing = selectFolder(TREE, "Computing")!;
    expect(collectLinks(computing).map((l) => l.url)).toEqual([
      "https://example.com/c1",
      "https://example.com/c2",
      "https://example.com/ai1",
      "https://example.com/mcp1",
    ]);
  });

  it("dedupes by URL within the result, keeping the first occurrence", () => {
    const folder: Folder = {
      name: "x",
      folders: [
        {
          name: "y",
          folders: [],
          links: [link("https://a.test/", "from y")],
        },
      ],
      links: [link("https://a.test/", "from x"), link("https://b.test/")],
    };
    const out = collectLinks(folder);
    expect(out.map((l) => l.url)).toEqual(["https://a.test/", "https://b.test/"]);
    const a = out.find((l) => l.url === "https://a.test/")!;
    expect(a.title).toBe("from x");
  });

  it("returns an empty array for a folder with no links anywhere", () => {
    const empty: Folder = { name: "e", folders: [{ name: "f", folders: [], links: [] }], links: [] };
    expect(collectLinks(empty)).toEqual([]);
  });
});
