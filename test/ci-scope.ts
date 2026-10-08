export const ESSENTIAL_WORKERS_FILES = [
  "test/integration/deletion-guards.test.ts",
  "test/integration/publication-guards.test.ts",
  "test/integration/spend-guards.test.ts",
  "test/integration/tenant-guards.test.ts",
] as const;

export const ESSENTIAL_NODE_FILES = [
  "test/unit/control-plane-guards.test.ts",
  "test/unit/operator-guards.test.ts",
  "test/unit/pipeline-guards.test.ts",
] as const;
