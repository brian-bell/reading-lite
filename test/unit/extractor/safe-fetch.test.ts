import { describe, expect, it, vi } from "vitest";
import { BlockedHostError } from "../../../src/modules/extractor/errors";
import {
  resolveSafeDestination,
  safeFetch,
  TooManyRedirectsError,
  type LookupFn,
} from "../../../src/modules/extractor/safe-fetch";

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34" }];

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("safeFetch", () => {
  it("rejects alternate loopback IPv4 spellings before resolving or fetching", async () => {
    const base = vi.fn();
    const lookup = vi.fn();
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });

    for (const host of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"]) {
      await expect(wrapped(`http://${host}/admin`)).rejects.toBeInstanceOf(BlockedHostError);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(base).not.toHaveBeenCalled();
  });

  it("rechecks DNS on a same-host redirect and refuses a newly private answer", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34" }])
      .mockResolvedValueOnce([{ address: "10.0.0.5" }]);
    const base = vi.fn().mockResolvedValue(redirect("/admin"));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });

    // This proves per-hop revalidation, not pinning between lookup and connect.
    await expect(wrapped("https://changing.example/start")).rejects.toBeInstanceOf(BlockedHostError);
    expect(lookup.mock.calls).toEqual([["changing.example"], ["changing.example"]]);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("returns the vetted DNS addresses so a caller can connect without resolving again", async () => {
    const lookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

    await expect(resolveSafeDestination("https://public.example/article", lookup)).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("returns a public IP literal without consulting DNS", async () => {
    const lookup = vi.fn();

    await expect(resolveSafeDestination("http://93.184.216.34/article", lookup)).resolves.toEqual([
      { address: "93.184.216.34" },
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("fails closed when DNS successfully returns no addresses", async () => {
    const lookup: LookupFn = async () => [];

    await expect(resolveSafeDestination("https://empty.example/article", lookup)).rejects.toThrow(
      "resolved to no addresses",
    );
  });

  it("rejects a redirect to a LAN host without issuing the second fetch", async () => {
    const base = vi.fn().mockResolvedValue(redirect("http://192.168.1.1/admin"));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    await expect(wrapped("https://public.example/start")).rejects.toThrow(/192\.168\.1\.1/);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("applies the redirect-target rewrite hook to every hop, still vetting the result", async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://public.example/canonical"))
      .mockResolvedValueOnce(new Response("ok"));
    const seen: string[] = [];
    const wrapped = safeFetch(base as unknown as typeof fetch, {
      lookup: publicLookup,
      rewriteRedirect: (target) => {
        seen.push(target);
        return `${target}.json?raw=1`;
      },
    });

    const res = await wrapped("https://public.example/start.json?raw=1");

    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://public.example/canonical"]);
    expect(vi.mocked(base).mock.calls.map((call) => call[0])).toEqual([
      "https://public.example/start.json?raw=1",
      "https://public.example/canonical.json?raw=1",
    ]);
  });

  it("rejects a rewritten redirect target that resolves privately", async () => {
    const base = vi.fn().mockResolvedValue(redirect("https://public.example/canonical"));
    const lookup: LookupFn = async (hostname) => [
      { address: hostname === "evil.example" ? "192.168.1.2" : "93.184.216.34" },
    ];
    const wrapped = safeFetch(base as unknown as typeof fetch, {
      lookup,
      rewriteRedirect: () => "https://evil.example/hijacked.json",
    });

    // The hook output goes through the same per-hop destination check: a
    // rewrite cannot smuggle a request past the guard.
    await expect(wrapped("https://public.example/start")).rejects.toThrow(/192\.168\.1\.2/);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("gives up after the hop ceiling with a structured error", async () => {
    const base = vi.fn().mockImplementation(async (url: string) => {
      const n = Number(new URL(url).pathname.slice(1) || 0);
      return redirect(`https://public.example/${n + 1}`);
    });
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup, maxHops: 5 });

    await expect(wrapped("https://public.example/0")).rejects.toThrow(TooManyRedirectsError);
    expect(base).toHaveBeenCalledTimes(6); // initial + 5 followed hops, then refuse
  });

  it("rejects a public hostname that resolves to a private address before connecting", async () => {
    const base = vi.fn();
    const lookup: LookupFn = async () => [{ address: "10.0.0.5" }];
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });

    await expect(wrapped("https://rebinder.example/")).rejects.toThrow(/10\.0\.0\.5/);
    expect(base).not.toHaveBeenCalled();
  });

  it("rejects when any one of several resolved addresses is private", async () => {
    const base = vi.fn();
    const lookup: LookupFn = async () => [{ address: "93.184.216.34" }, { address: "::ffff:10.0.0.5" }];
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });

    await expect(wrapped("https://rebinder.example/")).rejects.toThrow(/blocked/i);
    expect(base).not.toHaveBeenCalled();
  });

  it("passes a clean public chain through transparently, forcing redirect: manual on every hop", async () => {
    const final = new Response("article body", { status: 200 });
    const base = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://public.example/moved"))
      .mockResolvedValueOnce(final);
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    // makeBrowserFetch hardcodes redirect: "follow" — safeFetch must override it.
    const res = await wrapped("https://public.example/start", { redirect: "follow" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("article body");
    expect(base).toHaveBeenCalledTimes(2);
    for (const call of base.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: "manual" });
    }
  });

  it("resolves a relative Location against the current hop URL", async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(redirect("/canonical"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    await wrapped("https://public.example/old/path");

    expect(base.mock.calls[1]![0]).toBe("https://public.example/canonical");
  });

  it("rejects a redirect to a non-http(s) scheme", async () => {
    const base = vi.fn().mockResolvedValue(redirect("file:///etc/passwd"));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    await expect(wrapped("https://public.example/")).rejects.toThrow(/scheme/);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("blocks IP-literal hosts directly without consulting DNS", async () => {
    const base = vi.fn();
    const lookup = vi.fn();
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });

    await expect(wrapped("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/169\.254/);
    expect(base).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not resolve public IP literals through DNS either", async () => {
    const base = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const lookup = vi.fn();
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });

    const res = await wrapped("http://93.184.216.34/");
    expect(res.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("abandons a stalled DNS lookup when the caller's timeout signal fires", async () => {
    const base = vi.fn();
    const lookup: LookupFn = () => new Promise(() => {}); // never settles
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });
    const controller = new AbortController();

    const pending = wrapped("https://stalled-resolver.example/", { signal: controller.signal });
    controller.abort();

    // AbortError is what fetchBounded maps to FetchTimeoutError, so the
    // extraction timeout stays meaningful across the resolve step.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(base).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted request without resolving or connecting", async () => {
    const base = vi.fn();
    const lookup = vi.fn();
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup });

    await expect(
      wrapped("https://public.example/", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(lookup).not.toHaveBeenCalled();
    expect(base).not.toHaveBeenCalled();
  });

  it("preserves headers and signal when the caller passes a Request", async () => {
    const base = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    await wrapped(new Request("https://public.example/", { headers: { "user-agent": "reading-agent/1" } }));

    const forwarded = base.mock.calls[0]![1] as RequestInit;
    expect(new Headers(forwarded.headers).get("user-agent")).toBe("reading-agent/1");
    expect(forwarded.redirect).toBe("manual");
  });

  it.each([
    [304, "not modified"], // conditional GETs are now forwardable, so this is reachable
    [300, "multiple choices"],
    [305, "use proxy"],
  ])("returns a %i response with a Location instead of following it", async (status) => {
    const base = vi
      .fn()
      .mockResolvedValue(new Response(null, { status, headers: { location: "https://public.example/other" } }));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    const res = await wrapped("https://public.example/start");

    expect(res.status).toBe(status);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])("follows a %i redirect", async (status) => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status, headers: { location: "https://public.example/moved" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    const res = await wrapped("https://public.example/start");

    expect(res.status).toBe(200);
    expect(base.mock.calls[1]![0]).toBe("https://public.example/moved");
  });

  it("strips credential headers when a redirect crosses origins", async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://elsewhere.example/landing"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    await wrapped("https://public.example/start", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "user-agent": "reading-agent/1",
      },
    });

    const first = new Headers((base.mock.calls[0]![1] as RequestInit).headers);
    expect(first.get("authorization")).toBe("Bearer secret");

    const second = new Headers((base.mock.calls[1]![1] as RequestInit).headers);
    expect(second.get("authorization")).toBeNull();
    expect(second.get("cookie")).toBeNull();
    expect(second.get("user-agent")).toBe("reading-agent/1"); // non-credential headers survive
  });

  it("keeps credential headers on a same-origin redirect", async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(redirect("/canonical"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    await wrapped("https://public.example/start", { headers: { authorization: "Bearer secret" } });

    expect(new Headers((base.mock.calls[1]![1] as RequestInit).headers).get("authorization")).toBe("Bearer secret");
  });

  it("keeps credentials stripped when a later hop returns to the original origin", async () => {
    const base = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://elsewhere.example/bounce"))
      .mockResolvedValueOnce(redirect("https://public.example/back"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    await wrapped("https://public.example/start", { headers: { authorization: "Bearer secret" } });

    expect(new Headers((base.mock.calls[2]![1] as RequestInit).headers).get("authorization")).toBeNull();
  });

  it("cancels the terminal redirect body when the hop ceiling is hit", async () => {
    const cancelled: number[] = [];
    const base = vi.fn().mockImplementation(async (url: string) => {
      const n = Number(new URL(url).pathname.slice(1) || 0);
      const body = new ReadableStream({
        cancel() {
          cancelled.push(n);
        },
      });
      return new Response(body, { status: 302, headers: { location: `https://public.example/${n + 1}` } });
    });
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup, maxHops: 2 });

    await expect(wrapped("https://public.example/0")).rejects.toThrow(TooManyRedirectsError);
    expect(cancelled).toEqual([0, 1, 2]); // including the hop that tripped the ceiling
  });

  it("redacts userinfo from BlockedHostError so passwords do not land in manifests", async () => {
    const err = new BlockedHostError("https://alice:s3cret@example.com/article", "userinfo is not allowed");
    expect(err.url).toBe("https://example.com/article");
    expect(err.message).toContain("https://example.com/article");
    expect(err.message).not.toContain("s3cret");
    expect(err.message).not.toContain("alice");
    expect(JSON.stringify({ url: err.url, message: err.message })).not.toContain("s3cret");
  });

  it("redacts userinfo from an unparseable URL in BlockedHostError", () => {
    const err = new BlockedHostError("https://alice:s3cret@%%%", "invalid url");
    expect(err.url).not.toContain("s3cret");
    expect(err.message).not.toContain("s3cret");
    expect(err.url).toContain("[redacted]@");
  });

  it("rejects a start URL with userinfo without connecting, and omits the password from the error", async () => {
    const base = vi.fn();
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    const err = await wrapped("https://alice:s3cret@public.example/start").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect((err as BlockedHostError).url).toBe("https://public.example/start");
    expect(String(err)).not.toContain("s3cret");
    expect(String(err)).not.toContain("alice:");
    expect(base).not.toHaveBeenCalled();
  });

  it("rejects a redirect Location with userinfo without issuing the second fetch, and omits the password", async () => {
    const base = vi.fn().mockResolvedValue(redirect("https://alice:s3cret@public.example/admin"));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    const err = await wrapped("https://public.example/start").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(String(err)).not.toContain("s3cret");
    expect((err as BlockedHostError).url).toBe("https://public.example/admin");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("treats an invalid redirect Location as BlockedHostError instead of TypeError", async () => {
    const base = vi.fn().mockResolvedValue(redirect("http://["));
    const wrapped = safeFetch(base as unknown as typeof fetch, { lookup: publicLookup });

    const err = await wrapped("https://public.example/start").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as BlockedHostError).reason).toMatch(/invalid redirect location/i);
    expect(base).toHaveBeenCalledTimes(1);
  });
});
