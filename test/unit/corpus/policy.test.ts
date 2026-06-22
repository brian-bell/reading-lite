import { describe, expect, it } from "vitest";
import { planByAction, recoveryAction } from "../../../scripts/corpus-lib/policy";
import { reasonForFailure } from "../../../scripts/corpus-lib/reason";
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

  it("recovers a re-audited YouTube reading instead of skipping it (issue #17)", () => {
    // The override that hard-labeled YouTube "not an article" is gone, so a
    // re-audited YouTube reading derives a status-based reason and routes to a
    // real recovery action (here a 5xx → reprocess) rather than skip.
    const reason = reasonForFailure("BadStatusError", "status 503", "https://www.youtube.com/watch?v=YtTWNzOtkxU");
    expect(reason).not.toMatch(/not an article|youtube/i);
    expect(recoveryAction(row({ code: "BadStatusError", message: "status 503", reason })).action).toBe(
      "reprocess",
    );
  });

  it("recovers a legacy YouTube audit row whose stored reason still says 'not an article' (issue #17)", () => {
    // A pre-#17 audit file carries the old override reason verbatim. The URL is
    // a YouTube watch page, so the legacy "Not an article" reason must not
    // short-circuit to skip — it routes by its actual error instead.
    expect(
      recoveryAction(
        row({
          url: "https://www.youtube.com/watch?v=YtTWNzOtkxU",
          code: "BadStatusError",
          message: "status 503",
          reason: "Not an article — YouTube video page",
        }),
      ).action,
    ).toBe("reprocess");
    // youtu.be short links too.
    expect(
      recoveryAction(
        row({
          url: "https://youtu.be/YtTWNzOtkxU",
          code: "BadToolInputError",
          reason: "Not an article — YouTube video page",
        }),
      ).action,
    ).toBe("reprocess");
  });

  it("still skips a genuine non-article (PDF) reason for non-YouTube urls", () => {
    expect(
      recoveryAction(row({ url: "https://a.com/x.pdf", code: "BadStatusError", message: "status 200", reason: "Not an article — PDF" })).action,
    ).toBe("skip");
  });

  it("does not skip a reason merely because it mentions YouTube (issue #17)", () => {
    // YouTube is no longer a hard-skip class, so a reason string containing
    // "YouTube" must route by its actual error rather than skip.
    expect(
      recoveryAction(
        row({ code: "BadStatusError", message: "status 503", reason: "Stuck on a YouTube watch page" }),
      ).action,
    ).toBe("reprocess");
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
