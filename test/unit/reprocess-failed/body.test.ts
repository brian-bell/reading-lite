import { describe, expect, it } from "vitest";
import { buildReprocessBody } from "../../../scripts/reprocess-failed-lib/body";

describe("buildReprocessBody", () => {
  it("emits an empty object when neither flag is set", () => {
    expect(buildReprocessBody({ force: false, email: undefined })).toBe("{}");
  });

  it("emits force only when force is true", () => {
    expect(buildReprocessBody({ force: true, email: undefined })).toBe('{"force":true}');
  });

  it("emits email:true alone", () => {
    expect(buildReprocessBody({ force: false, email: true })).toBe('{"email":true}');
  });

  it("emits email:false explicitly when set", () => {
    expect(buildReprocessBody({ force: false, email: false })).toBe('{"email":false}');
  });

  it("emits both fields when both are set", () => {
    expect(buildReprocessBody({ force: true, email: true })).toBe(
      '{"force":true,"email":true}',
    );
  });
});
