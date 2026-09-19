import { describe, expect, it } from "vitest";
import { deployedProvenance, sha256 } from "../../../scripts/lib/release-evidence";

const sha = "a".repeat(40);
function fixture() {
  return {
    deployments: { deployments: [{ versions: [{ version_id: "version-1", percentage: 100 }] }] },
    version: { id: "version-1", annotations: { "workers/tag": sha }, resources: { bindings: [
      { name: "APP_ENV", type: "plain_text", text: "staging" },
      { name: "WEB_BASE_URL", type: "plain_text", text: "https://staging.readinglite.ai/" },
      { name: "TENANT_DATA_PLANE", type: "plain_text", text: "1" },
      { name: "HYPERDRIVE", type: "hyperdrive", id: "staging-hyperdrive" },
      { name: "AUTH_ROOT_SECRET", type: "secret_text", text: "SECRET" },
    ] } },
  };
}

describe("release deployment provenance", () => {
  it("captures active version and auth config without retaining secrets", () => {
    const f = fixture();
    const p = deployedProvenance(f.deployments, f.version, sha, sha256("config"));
    expect(p.version_id).toBe("version-1");
    expect(JSON.stringify(p)).not.toContain("SECRET");
    f.version.resources.bindings[3]!.id = "changed-hyperdrive";
    expect(deployedProvenance(f.deployments, f.version, sha, sha256("config")).effective_config_sha256).not.toBe(p.effective_config_sha256);
  });
  it.each(["tag", "id", "split", "missing", "production", "duplicate"])("refuses %s provenance", kind => {
    const f = fixture();
    if (kind === "tag") f.version.annotations["workers/tag"] = "other";
    if (kind === "id") f.version.id = "other";
    if (kind === "split") f.deployments.deployments[0]!.versions[0]!.percentage = 50;
    if (kind === "missing") f.version.resources.bindings.splice(3, 1);
    if (kind === "production") f.version.resources.bindings[0]!.text = "production";
    if (kind === "duplicate") f.version.resources.bindings.push(f.version.resources.bindings[0]!);
    expect(() => deployedProvenance(f.deployments, f.version, sha, sha256("config"))).toThrow();
  });
});
