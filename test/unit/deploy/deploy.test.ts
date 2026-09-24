import { describe, expect, it } from "vitest";
import { buildWranglerArgs, parseDeployEnv } from "../../../scripts/ops-lib/commands/deploy-worker";

describe("Worker deploy wrapper", () => {
  it("builds a dry-run production deploy by default-compatible args", () => {
    expect(buildWranglerArgs({ env: "production", execute: false })).toEqual([
      "deploy",
      "--env",
      "production",
      "--dry-run",
    ]);
  });

  it("builds an executable staging deploy", () => {
    expect(buildWranglerArgs({ env: "staging", execute: true })).toEqual([
      "deploy",
      "--env",
      "staging",
    ]);
  });

  it("accepts only production and staging env names", () => {
    expect(parseDeployEnv("production")).toBe("production");
    expect(parseDeployEnv("staging")).toBe("staging");
    expect(parseDeployEnv("dev")).toBeNull();
  });
});

