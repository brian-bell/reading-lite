import { describe, expect, it } from "vitest";
import {
  currentLoadId,
  TRAIL_LIMIT,
  previousHop,
  trailAfterFollowing,
  trailAfterReturning,
  trailOf,
  type TrailHop,
} from "../src/reading-trail";

// The trail in history state (design spec, Routes and navigation state): at
// most ten hops, and only from this document load.

function hop(n: number): TrailHop {
  return { id: `rd_${n}`, title: `Reading ${n}`, kind: "connection", reason: `because ${n}` };
}

describe("trailOf", () => {
  it("reads the hops a location from this load carries", () => {
    expect(trailOf({ trail: { load: currentLoadId(), hops: [hop(1)] } })).toEqual([hop(1)]);
  });

  it("is empty without state, as a shared link is", () => {
    expect(trailOf(undefined)).toEqual([]);
    expect(trailOf({})).toEqual([]);
  });

  // A reload keeps window.history.state, so the trail it holds would come back
  // with the page. It was written by another document load, so it does not count.
  it("drops a trail written by another document load", () => {
    expect(trailOf({ trail: { load: "an earlier load", hops: [hop(1)] } })).toEqual([]);
  });
});

describe("trailAfterFollowing", () => {
  it("appends the hop, stamped with this load", () => {
    expect(trailAfterFollowing([hop(1)], hop(2))).toEqual({ load: currentLoadId(), hops: [hop(1), hop(2)] });
  });

  it("keeps the most recent ten hops", () => {
    let hops: TrailHop[] = [];
    for (let n = 1; n <= TRAIL_LIMIT + 3; n += 1) hops = trailAfterFollowing(hops, hop(n)).hops;
    expect(hops).toHaveLength(TRAIL_LIMIT);
    expect(hops[0]).toEqual(hop(4));
    expect(hops.at(-1)).toEqual(hop(TRAIL_LIMIT + 3));
  });
});

describe("returning", () => {
  it("pops the hop the reader returns to", () => {
    expect(previousHop([hop(1), hop(2)])).toEqual(hop(2));
    expect(trailAfterReturning([hop(1), hop(2)])).toEqual({ load: currentLoadId(), hops: [hop(1)] });
    expect(previousHop([])).toBeUndefined();
  });
});
