import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAGING_RESOURCES,
  buildSecretCommands,
  buildStagingSetupCommands,
  buildStagingTeardownCommands,
  validateStagingResources,
} from "../../../scripts/staging-env";

describe("staging environment scripts", () => {
  it("builds the one-time staging resource setup commands", () => {
    expect(buildStagingSetupCommands(DEFAULT_STAGING_RESOURCES)).toEqual([
      {
        label: "Create staging R2 bucket",
        args: ["r2", "bucket", "create", "reading-lite-staging"],
      },
      {
        label: "Create staging Vectorize index",
        args: [
          "vectorize",
          "create",
          "reading-lite-staging",
          "--dimensions=1536",
          "--metric=cosine",
        ],
      },
      {
        label: "Create staging queue",
        args: ["queues", "create", "reading-lite-staging"],
      },
      {
        label: "Create staging dead-letter queue",
        args: ["queues", "create", "reading-lite-staging-dlq"],
      },
    ]);
  });

  it("builds destructive teardown commands in dependency-safe order", () => {
    expect(buildStagingTeardownCommands(DEFAULT_STAGING_RESOURCES)).toEqual([
      {
        label: "Remove staging queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging", "reading-lite-staging"],
      },
      {
        label: "Remove staging dead-letter queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-dlq", "reading-lite-staging"],
      },
      {
        label: "Delete staging Worker",
        args: ["delete", "reading-lite-staging", "--env", "staging", "--force"],
      },
      {
        label: "Delete staging queue",
        args: ["queues", "delete", "reading-lite-staging"],
      },
      {
        label: "Delete staging dead-letter queue",
        args: ["queues", "delete", "reading-lite-staging-dlq"],
      },
      {
        label: "Delete staging Vectorize index",
        args: ["vectorize", "delete", "reading-lite-staging", "--force"],
      },
      {
        label: "Delete staging R2 bucket",
        args: ["r2", "bucket", "delete", "reading-lite-staging"],
      },
    ]);
  });

  it("prints the staging secrets that must be set manually", () => {
    expect(buildSecretCommands()).toEqual([
      "wrangler secret put READER_API_TOKEN --env staging",
      "wrangler secret put ANTHROPIC_API_KEY --env staging",
      "wrangler secret put OPENAI_API_KEY --env staging",
      "wrangler secret put RESEND_API_KEY --env staging",
    ]);
  });

  it("refuses production-looking resource names", () => {
    expect(() =>
      validateStagingResources({
        ...DEFAULT_STAGING_RESOURCES,
        bucket: "reading-lite",
      }),
    ).toThrow(/refusing staging script resource name/i);
  });
});
