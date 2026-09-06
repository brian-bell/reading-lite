import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAGING_RESOURCES,
  buildSecretCommands,
  buildStagingSetupCommands,
  buildStagingTeardownCommands,
  emptyR2Bucket,
  resolveStagingR2Config,
  runWranglerCommands,
  validateStagingResources,
} from "../../../scripts/staging-env";
import type { WranglerCommand } from "../../../scripts/staging-env";

function commandShape(commands: WranglerCommand[]) {
  return commands.map(({ label, args }) => ({ label, args }));
}

describe("staging environment scripts", () => {
  it("builds the one-time staging resource setup commands", () => {
    expect(commandShape(buildStagingSetupCommands(DEFAULT_STAGING_RESOURCES))).toEqual([
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
      {
        label: "Create staging digest queue",
        args: ["queues", "create", "reading-lite-staging-digest"],
      },
      {
        label: "Create staging digest dead-letter queue",
        args: ["queues", "create", "reading-lite-staging-digest-dlq"],
      },
      {
        label: "Create staging wipe queue",
        args: ["queues", "create", "reading-lite-staging-wipe"],
      },
      {
        label: "Create staging wipe dead-letter queue",
        args: ["queues", "create", "reading-lite-staging-wipe-dlq"],
      },
      {
        label: "Create staging refresh queue",
        args: ["queues", "create", "reading-lite-staging-refresh"],
      },
      {
        label: "Create staging refresh dead-letter queue",
        args: ["queues", "create", "reading-lite-staging-refresh-dlq"],
      },
      {
        label: "Create staging D1 control plane",
        args: ["d1", "create", "reading-lite-control-staging"],
      },
    ]);
  });

  it("builds destructive teardown commands in dependency-safe order", () => {
    expect(commandShape(buildStagingTeardownCommands(DEFAULT_STAGING_RESOURCES))).toEqual([
      {
        label: "Remove staging queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging", "reading-lite-staging"],
      },
      {
        label: "Remove staging dead-letter queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-dlq", "reading-lite-staging"],
      },
      {
        label: "Remove staging digest queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-digest", "reading-lite-staging"],
      },
      {
        label: "Remove staging digest dead-letter queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-digest-dlq", "reading-lite-staging"],
      },
      {
        label: "Remove staging wipe queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-wipe", "reading-lite-staging"],
      },
      {
        label: "Remove staging wipe dead-letter queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-wipe-dlq", "reading-lite-staging"],
      },
      {
        label: "Remove staging refresh queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-refresh", "reading-lite-staging"],
      },
      {
        label: "Remove staging refresh dead-letter queue consumer",
        args: ["queues", "consumer", "remove", "reading-lite-staging-refresh-dlq", "reading-lite-staging"],
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
        label: "Delete staging digest queue",
        args: ["queues", "delete", "reading-lite-staging-digest"],
      },
      {
        label: "Delete staging digest dead-letter queue",
        args: ["queues", "delete", "reading-lite-staging-digest-dlq"],
      },
      {
        label: "Delete staging wipe queue",
        args: ["queues", "delete", "reading-lite-staging-wipe"],
      },
      {
        label: "Delete staging wipe dead-letter queue",
        args: ["queues", "delete", "reading-lite-staging-wipe-dlq"],
      },
      {
        label: "Delete staging refresh queue",
        args: ["queues", "delete", "reading-lite-staging-refresh"],
      },
      {
        label: "Delete staging refresh dead-letter queue",
        args: ["queues", "delete", "reading-lite-staging-refresh-dlq"],
      },
      {
        label: "Delete staging Vectorize index",
        args: ["vectorize", "delete", "reading-lite-staging", "--force"],
      },
      {
        label: "Delete staging D1 control plane",
        args: ["d1", "delete", "reading-lite-control-staging", "--skip-confirmation"],
      },
      {
        label: "Delete staging R2 bucket",
        args: ["r2", "bucket", "delete", "reading-lite-staging"],
      },
    ]);
  });

  it("marks setup and teardown commands as idempotent", () => {
    expect(
      buildStagingSetupCommands(DEFAULT_STAGING_RESOURCES).every(
        (command) => command.idempotentOk && command.idempotentOk.length > 0,
      ),
    ).toBe(true);
    expect(
      buildStagingTeardownCommands(DEFAULT_STAGING_RESOURCES).every(
        (command) => command.idempotentOk && command.idempotentOk.length > 0,
      ),
    ).toBe(true);
  });

  it("prints the staging secrets that must be set manually", () => {
    expect(buildSecretCommands()).toEqual([
      "wrangler secret put READER_API_TOKEN --env staging",
      "wrangler secret put AUTH_ROOT_SECRET --env staging",
      "wrangler secret put OPENAI_API_KEY --env staging",
      "wrangler secret put X_API_BEARER_TOKEN --env staging",
      "wrangler secret put RESEND_API_KEY --env staging",
    ]);
    expect(buildSecretCommands("anthropic")).toEqual([
      "wrangler secret put READER_API_TOKEN --env staging",
      "wrangler secret put AUTH_ROOT_SECRET --env staging",
      "wrangler secret put OPENAI_API_KEY --env staging",
      "wrangler secret put ANTHROPIC_API_KEY --env staging",
      "wrangler secret put X_API_BEARER_TOKEN --env staging",
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

  it("treats an absent R2 bucket as already empty", async () => {
    const lines: string[] = [];
    const client = {
      listKeys: async () => {
        throw new Error("R2 LIST failed: 404 NoSuchBucket");
      },
      delete: async () => {
        throw new Error("should not delete");
      },
    };

    await expect(
      emptyR2Bucket(client, DEFAULT_STAGING_RESOURCES.bucket, (line) => lines.push(line)),
    ).resolves.toBe(0);
    expect(lines).toContain("[EXECUTE] R2 bucket reading-lite-staging is already absent");
  });

  it("continues after idempotent wrangler failures", async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const code = await runWranglerCommands(
      [
        {
          label: "Create existing bucket",
          args: ["r2", "bucket", "create", "reading-lite-staging"],
          idempotentOk: [/already exists/i],
        },
        {
          label: "Create queue",
          args: ["queues", "create", "reading-lite-staging"],
        },
      ],
      {
        log: (line) => logs.push(line),
        runner: async (args) => {
          calls.push(args);
          return calls.length === 1
            ? { code: 1, stdout: "", stderr: "bucket already exists" }
            : { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(logs).toContain("[EXECUTE] already satisfied: Create existing bucket");
  });

  it("continues when Vectorize reports an index was already deleted", async () => {
    const commands = buildStagingTeardownCommands(DEFAULT_STAGING_RESOURCES);
    const vectorizeCommand = commands.find((command) =>
      command.args.includes("vectorize"),
    );
    expect(vectorizeCommand).toBeDefined();
    const code = await runWranglerCommands([vectorizeCommand!], {
      log: () => {},
      runner: async () => ({
        code: 1,
        stdout: "",
        stderr: 'vectorize.index.deleted - Index name "reading-lite-staging" [code: 3005]',
      }),
    });

    expect(code).toBe(0);
  });

  it("continues when a queue exists but its Worker consumer is absent", async () => {
    const commands = buildStagingTeardownCommands(DEFAULT_STAGING_RESOURCES);
    const consumerCommand = commands.find((command) =>
      command.args.includes("consumer"),
    );
    expect(consumerCommand).toBeDefined();
    const code = await runWranglerCommands([consumerCommand!], {
      log: () => {},
      runner: async () => ({
        code: 1,
        stdout: "",
        stderr:
          "No worker consumer 'reading-lite-staging' exists for queue reading-lite-staging",
      }),
    });

    expect(code).toBe(0);
  });

  it("stops on non-idempotent wrangler failures", async () => {
    const calls: string[][] = [];
    const code = await runWranglerCommands(
      [
        {
          label: "Delete worker",
          args: ["delete", "reading-lite-staging"],
          idempotentOk: [/not found/i],
        },
        {
          label: "Delete queue",
          args: ["queues", "delete", "reading-lite-staging"],
        },
      ],
      {
        log: () => {},
        runner: async (args) => {
          calls.push(args);
          return { code: 1, stdout: "", stderr: "permission denied" };
        },
      },
    );

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
