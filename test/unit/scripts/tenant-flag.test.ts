// The shared --tenant flag wrapper: it maps corpus-lib's selector resolution
// onto the CLI's UsageError so a missing or malformed selector exits 2 before
// any command reaches storage. The resolution rules themselves are covered in
// test/unit/corpus/tenant.test.ts.

import { describe, expect, it } from "vitest";
import { UsageError } from "../../../scripts/ops-lib/contract";
import { requireOperatorTenant } from "../../../scripts/ops-lib/tenant-flag";

describe("requireOperatorTenant", () => {
  it.each([undefined, ""])("throws a UsageError naming the flag when the selector is missing: %j", (selector) => {
    expect(() => requireOperatorTenant(selector)).toThrow(UsageError);
    expect(() => requireOperatorTenant(selector)).toThrow(/--tenant is required/);
  });

  it("throws a UsageError for a malformed selector", () => {
    expect(() => requireOperatorTenant("nope")).toThrow(UsageError);
    expect(() => requireOperatorTenant("nope")).toThrow(/malformed tenant selector/);
  });
});
