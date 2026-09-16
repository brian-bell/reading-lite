// The answers a backend stub gives the library's list for the acceptance
// matrix's common states (#416) and an empty library (#417), shared by e2e/backend-stub.js and
// smoke/backend-stub.js so both harnesses send the shape the backend sends.
// Each stub maps its own session names onto these.

export const LIST_SCENARIOS = {
  /** A reader with nothing saved yet (#417): "No readings yet." needs a session whose list is empty. */
  empty: { status: 200, body: { readings: [], limit: 20, offset: 0, has_more: false } },
  expired: { status: 401, body: { error: "unauthorized" } },
  forbidden: { status: 403, body: { error: "forbidden" } },
  mismatch: { status: 412, body: { error: "expected tenant mismatch", acting_tenant: "usr_bbbbbbbb" } },
  outage: { status: 503, body: { error: "backend unavailable" } },
};
