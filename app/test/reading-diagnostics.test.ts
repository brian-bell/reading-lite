import { describe, expect, it } from "vitest";
import pack from "../e2e/fixtures/fixture-pack.json" with { type: "json" };
import { ApiError } from "../src/api/errors";
import {
  attemptStatusLabel,
  attemptTriggerLabel,
  byteSize,
  diagnosticsFromResponse,
  eventStatusLabel,
  objectName,
  pointerVerdict,
  similarityFacts,
} from "../src/reading-diagnostics";
import { dateTimeOn } from "../src/reading-presentation";
import type { Reading } from "../src/reading";

// The Details section's data and copy (#373): the diagnostics projection and
// the fixed labels for similarity numbers, pointers, objects, and attempts.

const readings = pack.readings as Record<string, Reading>;
const ATTENTION = "rd_FXATTENT01";

describe("diagnosticsFromResponse", () => {
  it("accepts every fixture-pack diagnostics body", () => {
    for (const [id, body] of Object.entries(pack.diagnostics)) {
      const result = diagnosticsFromResponse(200, body);
      expect(result.state, id).toBe("ready");
      if (result.state !== "ready") continue;
      expect(result.diagnostics.id).toBe(id);
      expect(result.diagnostics.attempts.length).toBeGreaterThan(0);
      expect(result.diagnostics.attempts[0]!.events!.length).toBeGreaterThan(0);
    }
  });

  it("normalises a null index item and null event fields to absent", () => {
    const body = {
      ...pack.diagnostics[ATTENTION],
      index_item: null,
      attempts: [{ ...pack.diagnostics[ATTENTION].attempts[0], events: null, error: null }],
    };
    const result = diagnosticsFromResponse(200, body);
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.diagnostics.index_item).toBeUndefined();
    expect(result.diagnostics.attempts[0]!.events).toBeUndefined();
  });

  it("carries fields this app never reads through untouched", () => {
    const result = diagnosticsFromResponse(200, { ...pack.diagnostics[ATTENTION], manifest: { anything: true } });
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect((result.diagnostics as Record<string, unknown>).manifest).toEqual({ anything: true });
  });

  it("rejects a 200 whose read fields are malformed", () => {
    expect(() => diagnosticsFromResponse(200, { ...pack.diagnostics[ATTENTION], pointers: "no" })).toThrow(
      "diagnostics returned an unexpected body",
    );
    expect(() => diagnosticsFromResponse(200, { ...pack.diagnostics[ATTENTION], objects: [{ size: 1 }] })).toThrow(
      ApiError,
    );
  });

  it("turns 403 and 412 into states, since no Retry changes them", () => {
    expect(diagnosticsFromResponse(403, { error: "forbidden" })).toEqual({ state: "forbidden" });
    expect(diagnosticsFromResponse(412, { error: "mismatch", acting_tenant: "usr_b" })).toEqual({
      state: "account-changed",
      acting_tenant: "usr_b",
    });
  });

  // The reading rendered, so a diagnostics 404 is a failure to retry, not a
  // state; 401 goes to the shell's session machinery like every other throw.
  it("throws a 404, a 401, and anything unexpected, keeping the backend's message", () => {
    for (const status of [404, 401, 503]) {
      const failure = (() => {
        try {
          diagnosticsFromResponse(status, { error: `status ${status}` });
          return undefined;
        } catch (err) {
          return err;
        }
      })();
      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(status);
      expect((failure as ApiError).message).toBe(`status ${status}`);
    }
    expect(() => diagnosticsFromResponse(502, null)).toThrow("diagnostics returned 502");
  });
});

describe("similarityFacts", () => {
  it("lists count, highest, mean, and when they were computed", () => {
    expect(similarityFacts(readings[ATTENTION]!.similarity)).toEqual([
      { label: "Close readings", value: "2" },
      { label: "Highest similarity", value: "0.61" },
      { label: "Mean similarity", value: "0.58" },
      { label: "Computed", value: "7 September 2026, 09:30 UTC" },
    ]);
  });

  // Acceptance: "missing values are omitted". The sparse fixture has a count
  // and a date and no scores; an old manifest has no snapshot at all.
  it("omits what the snapshot does not carry", () => {
    expect(similarityFacts(readings.rd_FXSPARSE01!.similarity)).toEqual([
      { label: "Close readings", value: "0" },
      { label: "Computed", value: "6 September 2026, 18:25 UTC" },
    ]);
    expect(similarityFacts(readings.rd_FXPAST0001!.similarity)).toEqual([]);
    expect(similarityFacts(undefined)).toEqual([]);
    expect(similarityFacts({ max: 0.5 })).toEqual([{ label: "Highest similarity", value: "0.50" }]);
  });
});

describe("the fixed labels", () => {
  it("names a pointer check the way the SPA did", () => {
    expect(pointerVerdict({ exists: true, matches_manifest: true })).toBe("OK");
    expect(pointerVerdict({ exists: true, matches_manifest: false })).toBe("Mismatch");
    expect(pointerVerdict({ exists: false, matches_manifest: false })).toBe("Missing");
  });

  it("shows an object by its name under the reading's prefix", () => {
    const { key_prefix, objects } = pack.diagnostics[ATTENTION];
    expect(objects.map((o) => objectName(o.key, key_prefix))).toEqual([
      "manifest.json",
      "raw.html",
      "extracted.md",
      "attempts/at_FXATTENT01.json",
    ]);
    expect(objectName("elsewhere/x", key_prefix)).toBe("elsewhere/x");
    // On the tenant data plane object keys carry the tenant root in front of
    // the stored, relative prefix.
    expect(objectName(`u/usr_a/${key_prefix}/raw.html`, key_prefix)).toBe("raw.html");
  });

  it("sizes a file the way a reader would", () => {
    expect(byteSize(0)).toBe("0 B");
    expect(byteSize(1023)).toBe("1023 B");
    expect(byteSize(1536)).toBe("1.5 KB");
    expect(byteSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(byteSize(undefined)).toBeUndefined();
  });

  it("labels attempts and events, and keeps a value it does not know", () => {
    expect(["submit", "reprocess", "import", "batch"].map(attemptTriggerLabel)).toEqual([
      "Saved",
      "Reprocessed",
      "Imported",
      "batch",
    ]);
    expect(["running", "succeeded", "failed", "odd"].map(attemptStatusLabel)).toEqual([
      "Running",
      "Succeeded",
      "Failed",
      "odd",
    ]);
    expect(["started", "succeeded", "failed", "odd"].map(eventStatusLabel)).toEqual(["Started", "Done", "Failed", "odd"]);
  });

  it("formats a timestamp with its time of day, in UTC, and nothing for a bad one", () => {
    expect(dateTimeOn("2026-09-07T09:30:24.000Z")).toBe("7 September 2026, 09:30 UTC");
    expect(dateTimeOn("2026-09-07T00:05:00.000Z")).toBe("7 September 2026, 00:05 UTC");
    expect(dateTimeOn("nope")).toBeUndefined();
    expect(dateTimeOn(undefined)).toBeUndefined();
  });
});
