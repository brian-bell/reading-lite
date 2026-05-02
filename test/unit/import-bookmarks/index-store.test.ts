import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterUnseen,
  loadIndex,
  recordResult,
  saveIndex,
  type Index,
} from "../../../scripts/import-bookmarks-lib/index-store";

let tmpDir: string;
let indexPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "import-bookmarks-test-"));
  indexPath = path.join(tmpDir, "index.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadIndex", () => {
  it("returns an empty object when the file does not exist", async () => {
    const idx = await loadIndex(indexPath);
    expect(idx).toEqual({});
  });

  it("round-trips a saved index", async () => {
    const idx: Index = {
      "http://localhost:8787": {
        "https://a.test/": {
          id: "rd_a",
          submitted_at: "2026-05-01T00:00:00Z",
          classification: "new",
        },
      },
    };
    await saveIndex(indexPath, idx);
    const loaded = await loadIndex(indexPath);
    expect(loaded).toEqual(idx);
  });

  it("rejects malformed JSON with a clear error", async () => {
    await fs.writeFile(indexPath, "{ not json", "utf8");
    await expect(loadIndex(indexPath)).rejects.toThrow(/index file/i);
  });
});

describe("saveIndex", () => {
  it("writes atomically (no leftover tmp file on success)", async () => {
    await saveIndex(indexPath, { base: { "u": { id: "x", submitted_at: "t", classification: "new" } } });
    const entries = await fs.readdir(tmpDir);
    expect(entries).toContain("index.json");
    expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
  });

  it("creates the parent directory when missing", async () => {
    const nested = path.join(tmpDir, "a", "b", "index.json");
    await saveIndex(nested, {});
    expect(await fs.readFile(nested, "utf8")).toBe("{}\n");
  });
});

describe("filterUnseen", () => {
  const idx: Index = {
    "http://dev": {
      "https://a.test/": { id: "rd_a", submitted_at: "t", classification: "new" },
      "https://b.test/": { id: "rd_b", submitted_at: "t", classification: "existing" },
    },
    "http://prod": {
      "https://c.test/": { id: "rd_c", submitted_at: "t", classification: "new" },
    },
  };

  it("partitions URLs into unseen and seen for the given base", () => {
    const { unseen, seen } = filterUnseen(
      ["https://a.test/", "https://b.test/", "https://new.test/"],
      idx,
      "http://dev",
    );
    expect(unseen).toEqual(["https://new.test/"]);
    expect(seen).toEqual(["https://a.test/", "https://b.test/"]);
  });

  it("treats different bases as independent", () => {
    const { unseen, seen } = filterUnseen(
      ["https://a.test/", "https://c.test/"],
      idx,
      "http://prod",
    );
    expect(unseen).toEqual(["https://a.test/"]);
    expect(seen).toEqual(["https://c.test/"]);
  });

  it("returns everything as unseen when the base has no entries", () => {
    const { unseen, seen } = filterUnseen(["https://a.test/"], idx, "http://other");
    expect(unseen).toEqual(["https://a.test/"]);
    expect(seen).toEqual([]);
  });
});

describe("recordResult", () => {
  it("adds an entry under the given base", () => {
    const idx: Index = {};
    recordResult(idx, "http://dev", "https://x.test/", {
      id: "rd_x",
      submitted_at: "2026-05-01T00:00:00Z",
      classification: "new",
    });
    expect(idx).toEqual({
      "http://dev": {
        "https://x.test/": {
          id: "rd_x",
          submitted_at: "2026-05-01T00:00:00Z",
          classification: "new",
        },
      },
    });
  });

  it("is additive across calls without dropping existing entries", () => {
    const idx: Index = {
      "http://dev": {
        "https://a.test/": { id: "rd_a", submitted_at: "t", classification: "new" },
      },
    };
    recordResult(idx, "http://dev", "https://b.test/", {
      id: "rd_b",
      submitted_at: "t2",
      classification: "existing",
    });
    expect(Object.keys(idx["http://dev"]!)).toEqual(["https://a.test/", "https://b.test/"]);
  });

  it("overwrites the same URL under the same base (most recent classification wins)", () => {
    const idx: Index = {
      "http://dev": {
        "https://a.test/": { id: "rd_a", submitted_at: "t1", classification: "new" },
      },
    };
    recordResult(idx, "http://dev", "https://a.test/", {
      id: "rd_a",
      submitted_at: "t2",
      classification: "existing",
    });
    expect(idx["http://dev"]!["https://a.test/"]).toEqual({
      id: "rd_a",
      submitted_at: "t2",
      classification: "existing",
    });
  });
});
