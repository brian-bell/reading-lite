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

  it("reason overrides win over status (PDF/reddit skip even on a 403)", () => {
    expect(recoveryAction(row({ code: "BadStatusError", message: "status 403", reason: "Not an article — PDF" })).action).toBe("skip");
    expect(recoveryAction(row({ code: "BadStatusError", message: "status 403", reason: "Reddit — needs .json endpoint" })).action).toBe("skip");
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
