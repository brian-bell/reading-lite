import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPlaceholderD1DatabaseId,
  validateControlPlaneDeployReadiness,
  validateWranglerD1Bindings,
} from "../../../scripts/control-plane-env";

const REAL_STAGING_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REAL_PRODUCTION_ID = "11111111-2222-4333-8444-555555555555";

function writeToml(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "control-plane-env-"));
  const file = path.join(dir, "wrangler.toml");
  writeFileSync(file, contents);
  return file;
}

function tomlWithIds(stagingId: string, productionId: string): string {
  return `
name = "reading-lite-dev"

[[d1_databases]]
binding = "CONTROL_PLANE"
database_name = "reading-lite-control-dev"
database_id = "00000000-0000-0000-0000-000000000001"

[[env.staging.d1_databases]]
binding = "CONTROL_PLANE"
database_name = "reading-lite-control-staging"
database_id = "${stagingId}"

[[env.production.d1_databases]]
binding = "CONTROL_PLANE"
database_name = "reading-lite-control"
database_id = "${productionId}"
`;
}

describe("isPlaceholderD1DatabaseId", () => {
  it("rejects the known local/staging/production placeholders", () => {
    expect(isPlaceholderD1DatabaseId("00000000-0000-0000-0000-000000000001")).toBe(true);
    expect(isPlaceholderD1DatabaseId("00000000-0000-0000-0000-000000000002")).toBe(true);
    expect(isPlaceholderD1DatabaseId("00000000-0000-0000-0000-000000000003")).toBe(true);
    expect(isPlaceholderD1DatabaseId(" 00000000-0000-0000-0000-000000000002 ")).toBe(true);
  });

  it("accepts a real D1 database id", () => {
    expect(isPlaceholderD1DatabaseId(REAL_STAGING_ID)).toBe(false);
    expect(isPlaceholderD1DatabaseId("00000000-0000-0000-0000-000000000099")).toBe(false);
  });
});

describe("validateWranglerD1Bindings", () => {
  it("rejects placeholder staging and production D1 ids", () => {
    const file = writeToml(
      tomlWithIds("00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003"),
    );
    expect(() => validateWranglerD1Bindings(file)).toThrow(/placeholder/i);
  });

  it("accepts the checked-in wrangler.toml D1 ids", () => {
    expect(() => validateWranglerD1Bindings(path.join(process.cwd(), "wrangler.toml"))).not.toThrow();
  });

  it("accepts real staging and production D1 ids and ignores the local placeholder", () => {
    const file = writeToml(tomlWithIds(REAL_STAGING_ID, REAL_PRODUCTION_ID));
    expect(() => validateWranglerD1Bindings(file)).not.toThrow();
  });

  it("rejects a missing CONTROL_PLANE binding for a deployed env", () => {
    const file = writeToml(`
[[env.staging.d1_databases]]
binding = "CONTROL_PLANE"
database_name = "reading-lite-control-staging"
database_id = "${REAL_STAGING_ID}"
`);
    expect(() => validateWranglerD1Bindings(file)).toThrow(/production/i);
  });
});

describe("validateControlPlaneDeployReadiness", () => {
  it("fails closed when the env D1 id is a placeholder", () => {
    const file = writeToml(
      tomlWithIds("00000000-0000-0000-0000-000000000002", REAL_PRODUCTION_ID),
    );
    const readiness = validateControlPlaneDeployReadiness("staging", { wranglerTomlPath: file });
    expect(readiness.ok).toBe(false);
    if (readiness.ok) return;
    expect(readiness.error).toMatch(/placeholder/i);
    expect(readiness.requiredSecrets.runtime).toEqual(["AUTH_ROOT_SECRET"]);
    expect(readiness.requiredSecrets.bootstrapOnly).toEqual(["READER_API_TOKEN"]);
  });

  it("accepts a real D1 id and documents required secrets", () => {
    const file = writeToml(tomlWithIds(REAL_STAGING_ID, REAL_PRODUCTION_ID));
    const readiness = validateControlPlaneDeployReadiness("production", { wranglerTomlPath: file });
    expect(readiness).toMatchObject({
      ok: true,
      env: "production",
      d1: {
        binding: "CONTROL_PLANE",
        databaseName: "reading-lite-control",
        databaseId: REAL_PRODUCTION_ID,
      },
      requiredSecrets: {
        runtime: ["AUTH_ROOT_SECRET"],
        bootstrapOnly: ["READER_API_TOKEN"],
      },
    });
  });
});
