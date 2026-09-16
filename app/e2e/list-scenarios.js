// The answers a backend stub gives the library's list for the acceptance
// matrix's common states (#416), shared by e2e/backend-stub.js and
// smoke/backend-stub.js so both harnesses send the shape the backend sends.
// Each stub maps its own session names onto these.

export const LIST_SCENARIOS = {
  expired: { status: 401, body: { error: "unauthorized" } },
  forbidden: { status: 403, body: { error: "forbidden" } },
  mismatch: { status: 412, body: { error: "expected tenant mismatch", acting_tenant: "usr_bbbbbbbb" } },
  outage: { status: 503, body: { error: "backend unavailable" } },
};
