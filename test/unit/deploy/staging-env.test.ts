import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAGING_RESOURCES,
  buildSecretCommands,
  buildStagingSetupCommands,
  buildStagingTeardownCommands,
  emptyR2Bucket,
  resolveStagingR2Config,
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

  it("resolves R2 credentials but forces the staging bucket", () => {
    expect(
      resolveStagingR2Config(DEFAULT_STAGING_RESOURCES, {
        CORPUS_R2_ACCOUNT_ID: "acct",
        CORPUS_R2_ACCESS_KEY: "ak",
        CORPUS_R2_SECRET_KEY: "sk",
        CORPUS_R2_BUCKET: "reading-lite",
      }),
    ).toEqual({
      accountId: "acct",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      bucket: "reading-lite-staging",
    });
  });

  it("empties every listed R2 object before bucket deletion", async () => {
    const deleted: string[] = [];
    const lines: string[] = [];
    const client = {
      listKeys: async () => ["index/list.json", "readings/a/manifest.json"],
      delete: async (key: string) => {
        deleted.push(key);
      },
    };

    await expect(
      emptyR2Bucket(client, DEFAULT_STAGING_RESOURCES.bucket, (line) => lines.push(line)),
    ).resolves.toBe(2);
    expect(deleted).toEqual(["index/list.json", "readings/a/manifest.json"]);
    expect(lines).toContain("[EXECUTE] empty R2 bucket reading-lite-staging: deleting 2 objects");
  });
});
