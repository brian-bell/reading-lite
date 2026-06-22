import { describe, expect, it } from "vitest";
import { planByAction, recoveryAction } from "../../../scripts/corpus-lib/policy";
import type { AuditRow } from "../../../scripts/corpus-lib/types";

const row = (o: Partial<AuditRow>): AuditRow => ({
  category: "failed",
  url: "https://a.com/p",
  short: "a.com/p",
  reading_id: "rd_x",
  key_prefix: "readings/x",
  attempts: 1,
  ...o,
});

describe("recoveryAction", () => {
  it("reprocesses stranded pending; leaves orphan dups and fresh in-flight alone", () => {
    expect(recoveryAction(row({ category: "pending", class: "stranded" })).action).toBe("reprocess");
    expect(recoveryAction(row({ category: "pending", class: "orphan-dup" })).action).toBe("none");
    expect(recoveryAction(row({ category: "pending", class: "fresh" })).action).toBe("none");
  });

  it("leaves a failed orphan-dup alone (url already ready — a corpus-drop job, not recover)", () => {
    expect(recoveryAction(row({ category: "failed", class: "orphan-dup", code: "BadStatusError", message: "status 403" })).action).toBe("none");
  });

  it("skips teasers", () => {
    expect(recoveryAction(row({ category: "teaser" })).action).toBe("skip");
  });

  it("routes failed by error class/status", () => {
    const ba = (msg: string, reason = "") => row({ code: "BadStatusError", message: msg, reason });
    expect(recoveryAction(ba("status 403")).action).toBe("local-extract");
    expect(recoveryAction(ba("status 429")).action).toBe("local-extract");
    expect(recoveryAction(ba("status 404")).action).toBe("skip");
    expect(recoveryAction(ba("status 402")).action).toBe("skip");
    expect(recoveryAction(ba("status 526")).action).toBe("reprocess");
    expect(recoveryAction(row({ code: "BadToolInputError" })).action).toBe("reprocess");
    expect(recoveryAction(row({ code: "OversizedResponseError", reason: "Response exceeded fetch byte cap" })).action).toBe("local-extract");
  });

  it("reason overrides win over status (PDF skips even on a 403)", () => {
    expect(recoveryAction(row({ code: "BadStatusError", message: "status 403", reason: "Not an article — PDF" })).action).toBe("skip");
  });

  it("routes reddit reasons to skip (import via the local skill), overriding status", () => {
    // Reddit can't be re-fetched from a Node script (bot-challenge), so it's
    // skipped here regardless of status; recovery is the reddit-import skill,
    // which drives a logged-in Chrome session.
    expect(recoveryAction(row({ code: "BadStatusError", message: "status 526", reason: "Reddit — import via local reddit-import skill" })).action).toBe("skip");
    expect(recoveryAction(row({ code: "BadStatusError", message: "status 404", reason: "Reddit — import via local reddit-import skill" })).action).toBe("skip");
  });
});

describe("planByAction", () => {
  it("buckets rows by their action", () => {
    const plan = planByAction([
      row({ category: "pending", class: "stranded" }),
      row({ code: "BadStatusError", message: "status 404" }),
      row({ category: "teaser" }),
    ]);
    expect(plan.reprocess).toHaveLength(1);
    expect(plan.skip).toHaveLength(2);
    expect(plan["local-extract"]).toHaveLength(0);
  });
});
