import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  findDuplicateGroups,
  planExplicitPair,
  planSweep,
  type SweepItem,
} from "../../../scripts/corpus-lib/sweep";

const item = (o: Partial<SweepItem>): SweepItem => ({
  id: "rd_a",
  url: "https://a.com/p",
  key_prefix: "readings/2026/x-rd_a",
  status: "ready",
  created_at: "2026-01-01T00:00:00.000Z",
  ...o,
});

describe("canonicalizeUrl", () => {
  it("collapses the youtu.be short form onto the watch form", () => {
    expect(canonicalizeUrl("https://youtu.be/0oXOOlqVu5M")).toBe(
      canonicalizeUrl("https://www.youtube.com/watch?v=0oXOOlqVu5M"),
    );
  });

  it("collapses mobile, shorts and embed YouTube forms too", () => {
    const want = canonicalizeUrl("https://www.youtube.com/watch?v=abc12345678");
    expect(canonicalizeUrl("https://m.youtube.com/watch?v=abc12345678")).toBe(want);
    expect(canonicalizeUrl("https://www.youtube.com/shorts/abc12345678")).toBe(want);
    expect(canonicalizeUrl("https://www.youtube.com/embed/abc12345678")).toBe(want);
  });

  it("ignores YouTube tracking and timecode params", () => {
    expect(canonicalizeUrl("https://youtu.be/abc12345678?si=xyz&t=42")).toBe(
      canonicalizeUrl("https://www.youtube.com/watch?v=abc12345678"),
    );
  });

  it("keeps distinct YouTube videos distinct", () => {
    expect(canonicalizeUrl("https://youtu.be/aaaaaaaaaaa")).not.toBe(
      canonicalizeUrl("https://youtu.be/bbbbbbbbbbb"),
    );
  });

  it("normalizes scheme, www, trailing slash and fragment", () => {
    const want = canonicalizeUrl("https://example.com/post");
    expect(canonicalizeUrl("http://www.example.com/post/")).toBe(want);
    expect(canonicalizeUrl("https://example.com/post#section")).toBe(want);
  });

  it("strips every utm_* param, not an enumerated subset", () => {
    // utm_name is real and reddit's iOS share sheet emits it; enumerating
    // utm keys missed it once already.
    expect(canonicalizeUrl("https://example.com/p?utm_name=iossmf&utm_reader=x")).toBe(
      canonicalizeUrl("https://example.com/p"),
    );
  });

  it("strips reddit share_id", () => {
    expect(canonicalizeUrl("https://example.com/p?share_id=WUay1hW4p56ZhM8x3NGdE")).toBe(
      canonicalizeUrl("https://example.com/p"),
    );
  });

  it("strips utm tracking params but keeps meaningful query params", () => {
    expect(canonicalizeUrl("https://example.com/p?utm_source=x&utm_medium=y")).toBe(
      canonicalizeUrl("https://example.com/p"),
    );
    expect(canonicalizeUrl("https://example.com/p?page=2")).not.toBe(
      canonicalizeUrl("https://example.com/p"),
    );
  });

  it("orders query params so param order is not a difference", () => {
    expect(canonicalizeUrl("https://example.com/p?b=2&a=1")).toBe(
      canonicalizeUrl("https://example.com/p?a=1&b=2"),
    );
  });

  it("preserves path case but lowercases the host", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com/CasePath")).toBe("https://example.com/CasePath");
  });

  it("falls back to the raw string for an unparseable url", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("canonicalizeUrl — reddit", () => {
  it("collapses a comment permalink onto its thread", () => {
    expect(canonicalizeUrl("https://www.reddit.com/r/Xennials/comments/1kelqna/comment/mqk9hr1/")).toBe(
      canonicalizeUrl("https://www.reddit.com/r/Xennials/comments/1kelqna/my_kid_has_a_40_killer_sats/"),
    );
  });

  it("ignores the slug, which reddit treats as decoration", () => {
    expect(canonicalizeUrl("https://reddit.com/r/x/comments/1m5c9s8/challenging_airport/")).toBe(
      canonicalizeUrl("https://reddit.com/r/x/comments/1m5c9s8/some_other_slug/"),
    );
  });

  it("collapses the ios share form with share_id and utm_name", () => {
    expect(
      canonicalizeUrl(
        "https://www.reddit.com/r/flightsim/comments/1m5c9s8/challenging_airport_you_never_heard_of/?share_id=WUay1hW4p56ZhM8x3NGdE&utm_content=1&utm_medium=ios_app&utm_name=iossmf&utm_source=share&utm_term=22",
      ),
    ).toBe(canonicalizeUrl("https://www.reddit.com/r/flightsim/comments/1m5c9s8/challenging_airport_you_never_heard_of/"));
  });

  it("collapses old., new., np. and redd.it forms", () => {
    const want = canonicalizeUrl("https://www.reddit.com/r/sub/comments/1abcdef/slug/");
    expect(canonicalizeUrl("https://old.reddit.com/r/sub/comments/1abcdef/slug/")).toBe(want);
    expect(canonicalizeUrl("https://new.reddit.com/r/sub/comments/1abcdef/slug/")).toBe(want);
    expect(canonicalizeUrl("https://np.reddit.com/r/sub/comments/1abcdef/slug/")).toBe(want);
    expect(canonicalizeUrl("https://redd.it/1abcdef")).toBe(want);
  });

  it("keeps distinct threads distinct", () => {
    expect(canonicalizeUrl("https://reddit.com/r/x/comments/1aaaaaa/slug/")).not.toBe(
      canonicalizeUrl("https://reddit.com/r/x/comments/1bbbbbb/slug/"),
    );
  });

  it("leaves non-thread reddit urls alone", () => {
    expect(canonicalizeUrl("https://www.reddit.com/r/flightsim/")).toBe("https://reddit.com/r/flightsim");
    expect(canonicalizeUrl("https://www.reddit.com/user/someone")).toBe("https://reddit.com/user/someone");
  });
});

describe("findDuplicateGroups", () => {
  it("groups readings whose urls canonicalize the same", () => {
    const groups = findDuplicateGroups([
      item({ id: "rd_1", url: "https://www.youtube.com/watch?v=vid00000001" }),
      item({ id: "rd_2", url: "https://youtu.be/vid00000001" }),
      item({ id: "rd_3", url: "https://elsewhere.com/x" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id).sort()).toEqual(["rd_1", "rd_2"]);
  });

  it("ignores singletons", () => {
    expect(findDuplicateGroups([item({ id: "rd_1" }), item({ id: "rd_2", url: "https://b.com" })])).toEqual([]);
  });

  it("also groups exact-url duplicates", () => {
    const groups = findDuplicateGroups([
      item({ id: "rd_1", url: "https://same.com/p" }),
      item({ id: "rd_2", url: "https://same.com/p", status: "failed" }),
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe("planSweep", () => {
  const dupe = (over: Partial<SweepItem>[]): SweepItem[] =>
    over.map((o, n) => item({ id: `rd_${n}`, url: `https://youtu.be/vid00000001`, ...o }));

  it("keeps the ready copy and drops the non-ready ones", () => {
    const plan = planSweep(dupe([{ id: "rd_ready" }, { id: "rd_failed", status: "failed" }]));
    expect(plan.groups[0].keeper.id).toBe("rd_ready");
    expect(plan.groups[0].drops.map((d) => d.id)).toEqual(["rd_failed"]);
  });

  it("keeps the richer copy when both are ready", () => {
    const plan = planSweep(
      dupe([
        { id: "rd_thin", tldr: "short", keywords: ["a"], tags: ["x"] },
        { id: "rd_rich", tldr: "a much longer summary of the thing", keywords: ["a", "b", "c"], tags: ["x", "y"] },
      ]),
    );
    expect(plan.groups[0].keeper.id).toBe("rd_rich");
    expect(plan.groups[0].drops.map((d) => d.id)).toEqual(["rd_thin"]);
  });

  it("breaks an exact richness tie with the newer copy", () => {
    const plan = planSweep(
      dupe([
        { id: "rd_old", created_at: "2026-01-01T00:00:00.000Z" },
        { id: "rd_new", created_at: "2026-02-01T00:00:00.000Z" },
      ]),
    );
    expect(plan.groups[0].keeper.id).toBe("rd_new");
  });

  it("honours an explicit keeper override", () => {
    const plan = planSweep(
      dupe([
        { id: "rd_thin", tldr: "short" },
        { id: "rd_rich", tldr: "a much longer summary of the thing" },
      ]),
      { keep: ["rd_thin"] },
    );
    expect(plan.groups[0].keeper.id).toBe("rd_thin");
    expect(plan.groups[0].drops.map((d) => d.id)).toEqual(["rd_rich"]);
  });

  it("rejects a keeper override that names an id outside any duplicate group", () => {
    const plan = planSweep(dupe([{ id: "rd_a" }, { id: "rd_b" }]), { keep: ["rd_elsewhere"] });
    expect(plan.errors[0]).toMatch(/rd_elsewhere/);
  });

  it("rejects two keeper overrides naming the same group", () => {
    const plan = planSweep(dupe([{ id: "rd_a" }, { id: "rd_b" }]), { keep: ["rd_a", "rd_b"] });
    expect(plan.errors[0]).toMatch(/rd_a|rd_b/);
  });

  it("restricts the sweep to selected ids or urls when `only` is given", () => {
    const items = [
      ...dupe([{ id: "rd_a" }, { id: "rd_b" }]),
      item({ id: "rd_c", url: "https://youtu.be/vid00000002" }),
      item({ id: "rd_d", url: "https://www.youtube.com/watch?v=vid00000002" }),
    ];
    const plan = planSweep(items, { only: ["rd_c"] });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].items.map((i) => i.id).sort()).toEqual(["rd_c", "rd_d"]);
  });

  it("errors when `only` names something that is not part of a duplicate group", () => {
    const plan = planSweep(dupe([{ id: "rd_a" }, { id: "rd_b" }]), { only: ["rd_lonely"] });
    expect(plan.errors[0]).toMatch(/rd_lonely/);
  });

  it("never drops every copy in a group", () => {
    const plan = planSweep(dupe([{ id: "rd_a" }, { id: "rd_b" }, { id: "rd_c" }]));
    const g = plan.groups[0];
    expect(g.drops).toHaveLength(2);
    expect(g.drops.map((d) => d.id)).not.toContain(g.keeper.id);
  });

  it("flags ready drops so the caller knows a vector must be deleted", () => {
    const plan = planSweep(dupe([{ id: "rd_a" }, { id: "rd_b", status: "failed" }, { id: "rd_c" }]));
    const vectored = plan.groups[0].drops.filter((d) => d.status === "ready");
    expect(vectored.length).toBeGreaterThan(0);
    expect(plan.readyDropCount).toBe(vectored.length);
  });

  it("reports no groups and no errors on a clean corpus", () => {
    const plan = planSweep([item({ id: "rd_1" }), item({ id: "rd_2", url: "https://b.com" })]);
    expect(plan.groups).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.readyDropCount).toBe(0);
  });
});

describe("planExplicitPair", () => {
  const items = [
    item({ id: "rd_tweet", url: "https://x.com/theo/status/209", status: "ready" }),
    item({ id: "rd_video", url: "https://youtu.be/vid00000001", status: "ready" }),
    item({ id: "rd_fail", url: "https://c.com/x", status: "failed" }),
  ];

  it("builds a one-group plan dropping the named id in favour of the keeper", () => {
    const plan = planExplicitPair(items, { drop: "rd_tweet", keep: "rd_video" });
    expect(plan.errors).toEqual([]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].keeper.id).toBe("rd_video");
    expect(plan.groups[0].drops.map((d) => d.id)).toEqual(["rd_tweet"]);
    expect(plan.readyDropCount).toBe(1);
  });

  it("labels the group as an operator assertion, since urls do not match", () => {
    const plan = planExplicitPair(items, { drop: "rd_tweet", keep: "rd_video" });
    expect(plan.groups[0].reason).toMatch(/asserted|--keep|explicit/i);
  });

  it("errors when either id is missing from the corpus", () => {
    expect(planExplicitPair(items, { drop: "rd_nope", keep: "rd_video" }).errors[0]).toMatch(/rd_nope/);
    expect(planExplicitPair(items, { drop: "rd_tweet", keep: "rd_nope" }).errors[0]).toMatch(/rd_nope/);
  });

  it("refuses to drop and keep the same reading", () => {
    expect(planExplicitPair(items, { drop: "rd_video", keep: "rd_video" }).errors[0]).toMatch(/same/i);
  });

  it("refuses a keeper that is not ready, which would lose the summary", () => {
    const plan = planExplicitPair(items, { drop: "rd_video", keep: "rd_fail" });
    expect(plan.errors[0]).toMatch(/ready/i);
  });

  it("still counts a non-ready drop as needing no vector", () => {
    const plan = planExplicitPair(items, { drop: "rd_fail", keep: "rd_video" });
    expect(plan.errors).toEqual([]);
    expect(plan.readyDropCount).toBe(0);
  });
});
