import { describe, expect, it } from "vitest";
import { readingSubmitCommand, type ReadingSubmitDeps } from "../../../scripts/ops-lib/commands/reading-submit";
import { UsageError } from "../../../scripts/ops-lib/contract";

const SECRET = "sk-super-secret-token";

function makeDeps(overrides: Partial<ReadingSubmitDeps> = {}): {
  deps: ReadingSubmitDeps;
  out: string[];
  err: string[];
  requests: { url: string; method?: string }[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const requests: { url: string; method?: string }[] = [];
  let t = Date.parse("2026-08-22T12:00:00Z");
  const deps: ReadingSubmitDeps = {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method });
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "rd_1", status: "pending" }), { status: 202 });
      }
      return new Response(JSON.stringify({ id: "rd_1", status: "ready" }), { status: 200 });
    }) as unknown as typeof fetch,
    resolveTarget: (flags) => ({ base: flags.base ?? "https://api.test", token: flags.token ?? SECRET }),
    sleep: async () => {},
    now: () => (t += 100),
    ...overrides,
  };
  return { deps, out, err, requests };
}

describe("ops reading submit", () => {
  it("plan mode makes no request and never needs a token", async () => {
    const { deps, out, requests } = makeDeps({
      resolveTarget: () => ({ base: "https://api.test", token: "" }),
    });
    const code = await readingSubmitCommand.run(["https://example.com/a"], deps);
    expect(code).toBe(0);
    expect(requests).toHaveLength(0);
    const text = out.join("\n");
    expect(text).toContain("would POST https://api.test/api/readings");
    expect(text).toContain("NOT resolved");
    expect(text).toContain("--execute");
  });

  it("never prints the token value in plan or execute output", async () => {
    const plan = makeDeps();
    await readingSubmitCommand.run(["https://example.com/a"], plan.deps);
    const exec = makeDeps();
    await readingSubmitCommand.run(["https://example.com/a", "--execute"], exec.deps);
    for (const lines of [plan.out, plan.err, exec.out, exec.err]) {
      expect(lines.join("\n")).not.toContain(SECRET);
    }
  });

  it("--execute posts, polls to ready, and prints the final manifest", async () => {
    const { deps, out, requests } = makeDeps();
    const code = await readingSubmitCommand.run(["https://example.com/a", "--execute"], deps);
    expect(code).toBe(0);
    expect(requests[0]).toEqual({ url: "https://api.test/api/readings", method: "POST" });
    expect(requests.length).toBeGreaterThan(1);
    expect(JSON.parse(out.join("\n")).status).toBe("ready");
  });

  it("returns 1 when the reading fails", async () => {
    const { deps } = makeDeps({
      fetch: (async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ id: "rd_1" }), { status: 202 })
          : new Response(JSON.stringify({ id: "rd_1", status: "failed" }), { status: 200 })
      ) as unknown as typeof fetch,
    });
    expect(await readingSubmitCommand.run(["https://example.com/a", "--execute"], deps)).toBe(1);
  });

  it("returns 1 on a rejected POST", async () => {
    const { deps, err } = makeDeps({
      fetch: (async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 })) as unknown as typeof fetch,
    });
    expect(await readingSubmitCommand.run(["https://example.com/a", "--execute"], deps)).toBe(1);
    expect(err.join("\n")).toContain("401");
  });

  it("times out with exit 1 while still pending", async () => {
    let t = 0;
    const { deps, err } = makeDeps({
      now: () => (t += 80_000),
      fetch: (async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ id: "rd_1" }), { status: 202 })
          : new Response(JSON.stringify({ id: "rd_1", status: "pending" }), { status: 200 })
      ) as unknown as typeof fetch,
    });
    expect(await readingSubmitCommand.run(["https://example.com/a", "--execute"], deps)).toBe(1);
    expect(err.join("\n")).toContain("timed out");
  });

  it("requires a URL", async () => {
    const { deps } = makeDeps();
    await expect(readingSubmitCommand.run([], deps)).rejects.toThrow(UsageError);
  });

  it("requires a token only on the execute path", async () => {
    const { deps, requests } = makeDeps({
      resolveTarget: () => ({ base: "https://api.test", token: "" }),
    });
    await expect(
      readingSubmitCommand.run(["https://example.com/a", "--execute"], deps),
    ).rejects.toThrow(UsageError);
    expect(requests).toHaveLength(0);
  });
});
