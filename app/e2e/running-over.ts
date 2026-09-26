import pack from "./fixtures/fixture-pack.json" with { type: "json" };

// A reading with a new reprocess attempt running over it, as the backend
// writes it: a failed reading goes back to pending, a ready one stays ready
// with its prior material. Shared by the component tests
// (test/reading-reprocess.test.tsx) and the browser specs
// (e2e/specs/reprocess.spec.ts), which serve it as JSON, where `undefined`
// drops the failed reading's error.

export function runningOver<T extends { status: string }>(reading: T, stage = "fetch_source") {
  return {
    ...reading,
    ...(reading.status === "failed" ? { status: "pending", error: undefined } : {}),
    active_attempt: { id: "at_NEW01", trigger: "reprocess", status: "running", stage, started_at: pack.generated_at },
  };
}
