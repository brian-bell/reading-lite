import { describe, expect, it } from "vitest";
import { importBookmarksCommand, type ImportBookmarksDeps } from "../../../scripts/ops-lib/commands/import-bookmarks";
import { importRedditCommand, type ImportRedditDeps } from "../../../scripts/ops-lib/commands/import-reddit";
import { importYoutubeCommand, type ImportYoutubeDeps } from "../../../scripts/ops-lib/commands/import-youtube";
import { readingListCheckCommand, type ReadingListCheckDeps } from "../../../scripts/ops-lib/commands/reading-list-check";
import {
  readingListProcessCommand,
  type ReadingListProcessDeps,
} from "../../../scripts/ops-lib/commands/reading-list-process";
import { UsageError, type CommandIo } from "../../../scripts/ops-lib/contract";

const SECRET = "sk-slice5-secret";

function io(): { io: CommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
}

const BOOKMARKS_HTML = `
<DL><p>
  <DT><H3>Computing</H3>
  <DL><p>
    <DT><A HREF="https://a.example/one">One</A>
    <DT><A HREF="https://a.example/two">Two</A>
  </DL><p>
</DL><p>`;

describe("ops import bookmarks", () => {
  function makeDeps() {
    const { io: cio, out, err } = io();
    const state = { submits: [] as string[][], indexSaves: 0, prompts: 0 };
    const deps: ImportBookmarksDeps = {
      io: cio,
      readFile: async () => BOOKMARKS_HTML,
      loadIndex: async () => ({}),
      saveIndex: async () => {
        state.indexSaves++;
      },
      submitAll: async (urls, opts) => {
        state.submits.push(urls);
        for (let i = 0; i < urls.length; i++) {
          await opts.onResult?.({
            index: i + 1, total: urls.length, url: urls[i], classification: "new", id: `rd_${i}`,
          });
        }
        return { total: urls.length, new: urls.length, existing: 0, skipped: 0, errors: 0 };
      },
      createPrompter: () => {
        state.prompts++;
        return { ask: async () => "yes" as const, close: () => {} };
      },
      makeApi: () =>
        ({
          submit: async () => {
            throw new Error("no direct network");
          },
        }) as unknown as import("../../../scripts/lib/reading-api").ReadingApi,
      resolveToken: () => SECRET,
      now: () => Date.parse("2026-08-22T12:00:00Z"),
    };
    return { deps, out, err, state };
  }

  it("plan mode lists would-submit URLs without prompting, POSTing, or writing", async () => {
    const { deps, err, out, state } = makeDeps();
    const code = await importBookmarksCommand.run(["--file", "b.html"], deps);
    expect(code).toBe(0);
    expect(state.submits).toHaveLength(0);
    expect(state.indexSaves).toBe(0);
    expect(state.prompts).toBe(0);
    expect(err.join("\n")).toContain("https://a.example/one");
    expect(out.join("\n")).toContain('"submitted": 0');
  });

  it("--execute --quick submits without prompting and records the index", async () => {
    const { deps, state } = makeDeps();
    const code = await importBookmarksCommand.run(["--file", "b.html", "--execute", "--quick"], deps);
    expect(code).toBe(0);
    expect(state.submits).toEqual([["https://a.example/one", "https://a.example/two"]]);
    expect(state.indexSaves).toBe(2);
    expect(state.prompts).toBe(0);
  });

  it("--execute without --quick constructs the interactive prompter", async () => {
    const { deps, state } = makeDeps();
    await importBookmarksCommand.run(["--file", "b.html", "--execute"], deps);
    expect(state.prompts).toBe(1);
  });

  it("requires a token only on the execute path and never prints it", async () => {
    const { deps, out, err, state } = makeDeps();
    deps.resolveToken = () => "";
    await expect(importBookmarksCommand.run(["--file", "b.html", "--execute"], deps)).rejects.toThrow(UsageError);
    expect(state.submits).toHaveLength(0);
    expect(out.join("\n") + err.join("\n")).not.toContain(SECRET);
  });
});

const REDDIT_JSON = JSON.stringify([
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            title: "A thread", author: "someone", subreddit: "programming",
            selftext: "body text", permalink: "/r/programming/comments/abc/a_thread/",
            created_utc: 1700000000, score: 10, num_comments: 1,
          },
        },
      ],
    },
  },
  { kind: "Listing", data: { children: [] } },
]);

describe("ops import reddit", () => {
  function makeDeps() {
    const { io: cio, out, err } = io();
    const state = { imports: [] as string[] };
    const deps: ImportRedditDeps = {
      io: cio,
      readFile: async () => REDDIT_JSON,
      resolveApiTarget: () => ({ base: "https://api.test", token: SECRET }),
      makeApi: () => ({
        importMarkdown: async (body: { source_url: string }) => {
          state.imports.push(body.source_url);
          return { kind: "activated", id: "rd_x" } as const;
        },
      }),
    };
    return { deps, out, err, state };
  }

  const URL = "https://www.reddit.com/r/programming/comments/abc/a_thread/";

  it("plan mode prints the markdown without POSTing or needing a token", async () => {
    const { deps, out, state } = makeDeps();
    deps.resolveApiTarget = () => {
      throw new Error("target must not be resolved in plan mode");
    };
    const code = await importRedditCommand.run([URL, "--json", "t.json"], deps);
    expect(code).toBe(0);
    expect(state.imports).toHaveLength(0);
    expect(out.join("\n")).toContain("A thread");
  });

  it("--execute imports through the API", async () => {
    const { deps, state } = makeDeps();
    const code = await importRedditCommand.run([URL, "--json", "t.json", "--execute"], deps);
    expect(code).toBe(0);
    expect(state.imports).toHaveLength(1);
  });

  it("rejects a non-Reddit URL as usage error", async () => {
    const { deps } = makeDeps();
    await expect(
      importRedditCommand.run(["https://example.com/x", "--json", "t.json"], deps),
    ).rejects.toThrow(UsageError);
  });
});

describe("ops import youtube", () => {
  const OEMBED = JSON.stringify({ title: "Video title", author_name: "Author" });

  function makeDeps() {
    const { io: cio, out, err } = io();
    const state = { imports: [] as string[], transcripts: 0, lookups: [] as string[] };
    const deps: ImportYoutubeDeps = {
      io: cio,
      fetchText: async (url) => (url.includes("oembed") ? OEMBED : "<html></html>"),
      fetchTranscript: () => {
        state.transcripts++;
        return "the transcript";
      },
      resolveApiTarget: () => ({ base: "https://api.test", token: SECRET }),
      makeApi: () => ({
        importMarkdown: async (body: { source_url: string }) => {
          state.imports.push(body.source_url);
          return { kind: "activated", id: "rd_y" } as const;
        },
        lookup: async (url: string) => {
          state.lookups.push(url);
          return { kind: "not_found" } as const;
        },
      }),
    };
    return { deps, out, err, state };
  }

  const URL = "https://www.youtube.com/watch?v=YtTWNzOtkxU";

  it("plan mode extracts and previews without importing or needing a token", async () => {
    const { deps, out, state } = makeDeps();
    deps.resolveApiTarget = () => {
      throw new Error("target must not be resolved in plan mode");
    };
    const code = await importYoutubeCommand.run([URL], deps);
    expect(code).toBe(0);
    expect(state.imports).toHaveLength(0);
    expect(state.lookups).toHaveLength(0);
    expect(state.transcripts).toBe(1);
    expect(out.join("\n")).toContain("Video title");
  });

  it("--execute imports and checks noncanonical variants", async () => {
    const { deps, state } = makeDeps();
    const code = await importYoutubeCommand.run([URL, "--execute"], deps);
    expect(code).toBe(0);
    expect(state.imports).toEqual([URL]);
    expect(state.lookups.length).toBeGreaterThan(0);
  });

  it("--no-transcript skips the yt-dlp step", async () => {
    const { deps, state } = makeDeps();
    await importYoutubeCommand.run([URL, "--no-transcript"], deps);
    expect(state.transcripts).toBe(0);
  });
});

describe("ops reading-list check", () => {
  const ENTRIES = JSON.stringify([{ url: "https://a.example/one" }, { url: "https://a.example/two" }]);
  const LIST_INDEX = JSON.stringify({
    items: [{ id: "rd_1", url: "https://a.example/one", status: "ready", key_prefix: "readings/rd_1", created_at: "2026-08-01T00:00:00Z" }],
  });

  function makeDeps() {
    const { io: cio, out, err } = io();
    const state = { writes: [] as string[] };
    const deps: ReadingListCheckDeps = {
      io: cio,
      readFile: async () => ENTRIES,
      writeFileAtomic: async (p) => {
        state.writes.push(p);
      },
      fetchListIndex: async () => LIST_INDEX,
    };
    return { deps, out, err, state };
  }

  it("plan mode reads the corpus but writes nothing", async () => {
    const { deps, out, state } = makeDeps();
    const code = await readingListCheckCommand.run(["--file", "list.json"], deps);
    expect(code).toBe(0);
    expect(state.writes).toHaveLength(0);
    const summary = JSON.parse(out.join("\n"));
    expect(summary.executed).toBe(false);
    expect(summary.corpus_urls).toBe(1);
  });

  it("--execute writes the annotated list", async () => {
    const { deps, state } = makeDeps();
    const code = await readingListCheckCommand.run(["--file", "list.json", "--execute"], deps);
    expect(code).toBe(0);
    expect(state.writes).toHaveLength(1);
  });
});

describe("ops reading-list process", () => {
  const ENTRIES = JSON.stringify([
    { url: "https://a.example/one", processed: false },
    { url: "https://a.example/two", processed: true },
  ]);

  function makeDeps() {
    const { io: cio, out, err } = io();
    const state = { submits: [] as string[][], writes: 0, prompts: 0 };
    const deps: ReadingListProcessDeps = {
      io: cio,
      readFile: async () => ENTRIES,
      writeFileAtomic: async () => {
        state.writes++;
      },
      submitAll: async (urls, opts) => {
        state.submits.push(urls);
        for (let i = 0; i < urls.length; i++) {
          await opts.onResult?.({
            index: i + 1, total: urls.length, url: urls[i], classification: "new", id: `rd_${i}`,
          });
        }
        return { total: urls.length, new: urls.length, existing: 0, skipped: 0, errors: 0 };
      },
      createPrompter: () => {
        state.prompts++;
        return { ask: async () => "yes" as const, close: () => {} };
      },
      makeApi: () =>
        ({
          submit: async () => {
            throw new Error("no direct network");
          },
        }) as unknown as import("../../../scripts/lib/reading-api").ReadingApi,
      resolveToken: () => SECRET,
      now: () => Date.parse("2026-08-22T12:00:00Z"),
    };
    return { deps, out, err, state };
  }

  it("plan mode prints selected rows without prompting, POSTing, or writing", async () => {
    const { deps, err, out, state } = makeDeps();
    const previousUrl = process.env.READER_URL;
    delete process.env.READER_URL;
    try {
      const code = await readingListProcessCommand.run(["--file", "list.json"], deps);
      expect(code).toBe(0);
      expect(state.submits).toHaveLength(0);
      expect(state.writes).toBe(0);
      expect(state.prompts).toBe(0);
      expect(err.join("\n")).toContain("[plan] https://a.example/one");
      expect(err.join("\n")).toContain("https://readinglite.ai/api/readings");
      expect(JSON.parse(out.join("\n")).destination).toBe("https://readinglite.ai/api/readings");
    } finally {
      if (previousUrl === undefined) delete process.env.READER_URL;
      else process.env.READER_URL = previousUrl;
    }
  });

  it("honors --url over the production default without POSTing in plan mode", async () => {
    const { deps, out } = makeDeps();
    const code = await readingListProcessCommand.run(
      ["--file", "list.json", "--url", "http://127.0.0.1:8787/api/readings"],
      deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n")).destination).toBe("http://127.0.0.1:8787/api/readings");
  });

  it("--execute --quick submits the unprocessed entries and writes back outcomes", async () => {
    const { deps, state } = makeDeps();
    const code = await readingListProcessCommand.run(["--file", "list.json", "--execute", "--quick"], deps);
    expect(code).toBe(0);
    expect(state.submits).toEqual([["https://a.example/one"]]);
    expect(state.writes).toBeGreaterThan(0);
    expect(state.prompts).toBe(0);
  });

  it("requires a token only on the execute path", async () => {
    const { deps, state } = makeDeps();
    deps.resolveToken = () => "";
    await expect(
      readingListProcessCommand.run(["--file", "list.json", "--execute"], deps),
    ).rejects.toThrow(UsageError);
    expect(state.submits).toHaveLength(0);
  });
});
