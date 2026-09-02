import { describe, expect, it } from "vitest";
import { isDigestHourLocal, isDigestWeekday, isIanaTimeZone } from "../../../src/modules/time-zone";

describe("isIanaTimeZone", () => {
  it("accepts UTC and canonical IANA names from supportedValuesOf", () => {
    expect(isIanaTimeZone("UTC")).toBe(true);
    expect(isIanaTimeZone("America/New_York")).toBe(true);
    expect(isIanaTimeZone("Europe/London")).toBe(true);
  });

  it("rejects unknown, blank, and lowercase names", () => {
    expect(isIanaTimeZone("Not/A_Zone")).toBe(false);
    expect(isIanaTimeZone("")).toBe(false);
    expect(isIanaTimeZone("utc")).toBe(false);
  });
});

describe("isDigestHourLocal", () => {
  it("accepts integers 0 through 23", () => {
    expect(isDigestHourLocal(0)).toBe(true);
    expect(isDigestHourLocal(9)).toBe(true);
    expect(isDigestHourLocal(23)).toBe(true);
  });

  it("rejects 24, negatives, and non-integers", () => {
    expect(isDigestHourLocal(24)).toBe(false);
    expect(isDigestHourLocal(-1)).toBe(false);
    expect(isDigestHourLocal(9.5)).toBe(false);
    expect(isDigestHourLocal(Number.NaN)).toBe(false);
  });
});

describe("isDigestWeekday", () => {
  it("accepts ISO Monday=1 through Sunday=7", () => {
    expect(isDigestWeekday(1)).toBe(true);
    expect(isDigestWeekday(7)).toBe(true);
  });

  it("rejects JS getDay Sunday=0 and values outside 1-7", () => {
    expect(isDigestWeekday(0)).toBe(false);
    expect(isDigestWeekday(8)).toBe(false);
    expect(isDigestWeekday(1.5)).toBe(false);
  });
});
