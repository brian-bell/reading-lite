import { describe, expect, it } from "vitest";

import { listIanaTimeZones } from "./time-zone";

describe("listIanaTimeZones", () => {
  it("always includes UTC and sorts", () => {
    const zones = listIanaTimeZones();
    expect(zones).toContain("UTC");
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
  });

  it("includes common IANA names from Intl when available", () => {
    const zones = listIanaTimeZones();
    if (typeof Intl.supportedValuesOf === "function") {
      expect(zones).toContain("America/New_York");
      expect(zones).toContain("Europe/London");
    }
  });

  it("keeps a stored zone that is missing from the Intl list", () => {
    expect(listIanaTimeZones("Not/A_Zone")).toContain("Not/A_Zone");
  });
});
