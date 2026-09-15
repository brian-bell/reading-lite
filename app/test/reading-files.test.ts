import { describe, expect, it, vi } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import {
  fileProblem,
  offeredFiles,
  openFileTab,
  REVOKE_AFTER_MS,
  showFile,
  type FileOpener,
  type FileTab,
} from "../src/reading-files";
import type { Reading } from "../src/reading";

// "Open as file" (#373): which files a reading offers, and how one opens.

const readings = pack.readings as Record<string, Reading>;

function fakeTab(): FileTab {
  return { opener: {}, location: { href: "about:blank" }, close: vi.fn() };
}

function fakeWindow(tab: FileTab | null = fakeTab()) {
  const win: FileOpener & { blobs: Blob[]; timers: [() => void, number][] } = {
    blobs: [],
    timers: [],
    open: vi.fn(() => tab),
    URL: {
      createObjectURL: vi.fn((blob: Blob) => {
        win.blobs.push(blob);
        return `blob:app/${win.blobs.length}`;
      }),
      revokeObjectURL: vi.fn(),
    },
    setTimeout: vi.fn((handler: () => void, ms: number) => {
      win.timers.push([handler, ms]);
      return 1;
    }),
  };
  return win;
}

describe("offeredFiles", () => {
  it("offers both files for a captured source", () => {
    expect(offeredFiles(readings.rd_FXATTENT01!)).toEqual(["extracted", "raw"]);
  });

  // The Source view's rule: a manifest that says the source was not captured
  // is not asked for it. The raw capture is still offered; a 404 says so.
  it("offers only the raw capture when the manifest says the source was not captured", () => {
    expect(offeredFiles(readings.rd_FXRAWSRC01!)).toEqual(["raw"]);
    expect(offeredFiles(readings.rd_FXERR00001!)).toEqual(["raw"]);
  });
});

describe("openFileTab", () => {
  it("opens a blank tab on the click and severs it from this page", () => {
    const win = fakeWindow();
    const tab = openFileTab(win);
    expect(win.open).toHaveBeenCalledWith("", "_blank");
    expect(tab?.opener).toBeNull();
  });

  it("reports a refused tab as null", () => {
    expect(openFileTab(fakeWindow(null))).toBeNull();
  });
});

describe("showFile", () => {
  it("points the tab at the bytes as a plain-text blob, whatever they were", async () => {
    const win = fakeWindow();
    const tab = fakeTab();
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    showFile(tab, html.buffer, win);
    expect(tab.location.href).toBe("blob:app/1");
    // Never the stored content type: a blob: page runs in this app's origin.
    expect(win.blobs[0]!.type).toBe("text/plain; charset=utf-8");
    expect(await win.blobs[0]!.text()).toBe("<html><script>alert(1)</script></html>");
  });

  it("keeps bytes that are not UTF-8 text", async () => {
    const win = fakeWindow();
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00]);
    showFile(fakeTab(), pdf.buffer, win);
    expect(new Uint8Array(await win.blobs[0]!.arrayBuffer())).toEqual(pdf);
  });

  it("revokes the URL on a coarse delay, once the tab has had time to load it", () => {
    const win = fakeWindow();
    showFile(fakeTab(), new ArrayBuffer(1), win);
    expect(win.URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(win.timers).toHaveLength(1);
    expect(win.timers[0]![1]).toBe(REVOKE_AFTER_MS);
    win.timers[0]![0]();
    expect(win.URL.revokeObjectURL).toHaveBeenCalledWith("blob:app/1");
  });
});

describe("fileProblem", () => {
  it("has a sentence for each state that is not a file", () => {
    expect(fileProblem({ state: "unavailable" })).toBe("That file isn't available for this reading.");
    expect(fileProblem({ state: "forbidden" })).toBe("You don't have access to this reading's files.");
    expect(fileProblem({ state: "account-changed" })).toMatch(/different account/);
  });
});
