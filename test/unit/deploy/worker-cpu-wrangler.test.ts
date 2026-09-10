import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("hosted Worker CPU allowance", () => {
  for (const env of ["staging", "production"]) {
    it(`uploads an explicit 30-second CPU allowance for ${env}`, () => {
      // Resolve the same environment/inheritance rules as the deployment CLI.
      const config = unstable_readConfig({ config: "wrangler.toml", env }, { hideWarnings: true });
      expect(config.limits?.cpu_ms).toBe(30_000);
      expect(config.compatibility_flags).toContain("nodejs_compat");
      expect(config.vars.REFRESH_MAX_JUDGEMENTS).toBe("2");
    });
  }
});
