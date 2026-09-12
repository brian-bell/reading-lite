import { describe, expect, it } from "vitest";
import { plainSearch } from "../src/search";

describe("plainSearch", () => {
  it("keeps every value a string", () => {
    expect(plainSearch.parseSearch("?step_up=1&offset=20&q=true&next=%2Freadings%2Frd_ONE")).toEqual({
      step_up: "1",
      offset: "20",
      q: "true",
      next: "/readings/rd_ONE",
    });
  });

  it("keeps the first of repeated values and drops empty entries on write", () => {
    expect(plainSearch.parseSearch("?q=a&q=b")).toEqual({ q: "a" });
    expect(plainSearch.stringifySearch({ q: "a b", tag: undefined })).toBe("?q=a+b");
    expect(plainSearch.stringifySearch({})).toBe("");
  });

  it("writes strings back unquoted", () => {
    expect(plainSearch.stringifySearch({ step_up: "1", next: "/account/security", q: "null" })).toBe(
      "?step_up=1&next=%2Faccount%2Fsecurity&q=null",
    );
  });
});
