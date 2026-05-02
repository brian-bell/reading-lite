import { describe, expect, it } from "vitest";
import { parseBookmarksHtml } from "../../../scripts/import-bookmarks-lib/parse";

const FIXTURE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/bar1">Bar Link 1</A>
    </DL><p>
    <DT><H3>Computing</H3>
    <DL><p>
        <DT><A HREF="https://example.com/c1">C One</A>
        <DT><A HREF="https://example.com/c2">C Two — Unicode 你好</A>
        <DT><H3>AI</H3>
        <DL><p>
            <DT><A HREF="https://example.com/ai1">AI One</A>
            <DT><H3>MCP</H3>
            <DL><p>
                <DT><A HREF="https://example.com/mcp1">MCP One</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="https://example.com/c3?q=1&amp;r=2">C Three Entity</A>
    </DL><p>
    <DT><H3>Empty</H3>
    <DL><p>
    </DL><p>
</DL><p>`;

describe("parseBookmarksHtml", () => {
  const root = parseBookmarksHtml(FIXTURE);

  it("returns three top-level folders in document order", () => {
    expect(root.folders.map((f) => f.name)).toEqual([
      "Bookmarks Bar",
      "Computing",
      "Empty",
    ]);
  });

  it("places direct links under the right folder", () => {
    const computing = root.folders.find((f) => f.name === "Computing")!;
    expect(computing.links.map((l) => l.url)).toEqual([
      "https://example.com/c1",
      "https://example.com/c2",
      "https://example.com/c3?q=1&r=2",
    ]);
  });

  it("preserves unicode in titles", () => {
    const computing = root.folders.find((f) => f.name === "Computing")!;
    const c2 = computing.links.find((l) => l.url === "https://example.com/c2")!;
    expect(c2.title).toBe("C Two — Unicode 你好");
  });

  it("decodes HTML entities in URLs", () => {
    const computing = root.folders.find((f) => f.name === "Computing")!;
    const c3 = computing.links.find((l) => l.title === "C Three Entity")!;
    expect(c3.url).toBe("https://example.com/c3?q=1&r=2");
  });

  it("recurses into nested subfolders", () => {
    const computing = root.folders.find((f) => f.name === "Computing")!;
    const ai = computing.folders.find((f) => f.name === "AI")!;
    expect(ai.links.map((l) => l.url)).toEqual(["https://example.com/ai1"]);
    const mcp = ai.folders.find((f) => f.name === "MCP")!;
    expect(mcp.links.map((l) => l.url)).toEqual(["https://example.com/mcp1"]);
    expect(mcp.folders).toEqual([]);
  });

  it("handles empty folders without crashing", () => {
    const empty = root.folders.find((f) => f.name === "Empty")!;
    expect(empty.links).toEqual([]);
    expect(empty.folders).toEqual([]);
  });

  it("returns an empty tree when no DL exists", () => {
    const r = parseBookmarksHtml("<html><body><p>no bookmarks</p></body></html>");
    expect(r.folders).toEqual([]);
    expect(r.links).toEqual([]);
  });
});
