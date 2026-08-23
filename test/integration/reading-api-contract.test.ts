import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/router";
import type { Env } from "../../src/index";
import type { ProcessReadingEnvelopeV1 } from "../../src/control-plane/envelope";
import { mintReadingId, sha256Hex, type Services } from "../../src/services";
import { buildKeyPrefix } from "../../src/modules/stores/reading-store";
import { decodeIntakeResponse } from "../../scripts/lib/reading-api";
import { testReadingStore } from "../helpers/tenant-fixtures";

// Contract test for the operator-side Reading API client: the pure
// decodeIntakeResponse must round-trip the REAL router's responses (toHttp's
// wire shapes), not a hand-mirrored fixture. In particular it pins the 409
// disambiguation the client relies on: an initializing owner carries `id`, an
// attempt conflict does not.

const TOKEN = "test-token";

function services(): Services {
  return {
    // Intake never fetches upstream; a throw here proves it.
    fetch: (() => {
      throw new Error("no upstream fetch on the intake path");
    }) as unknown as typeof fetch,
    now: () => new Date().toISOString(),
    newId: mintReadingId,
  };
}

function installQueueStub(): void {
  (env as unknown as { READING_JOBS: unknown }).READING_JOBS = {
    send: vi.fn(async () => {}),
  };
}

async function clearBucket() {
  const list = await env.READINGS_BUCKET.list();
  for (const obj of list.objects) {
    await env.READINGS_BUCKET.delete(obj.key);
  }
}

beforeEach(installQueueStub);
afterEach(clearBucket);

function post(path: string, body: unknown) {
  const app = createApp({ services: services() });
  return app.request(
    path,
    {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function decoded(res: Response) {
  return decodeIntakeResponse(res.status, await res.json());
}

describe("decodeIntakeResponse against the live router", () => {
  it("202 submit decodes to activated with reading and attempt ids", async () => {
    const res = await post("/api/readings", { url: "https://contract.test/new", email: false });
    expect(res.status).toBe(202);
    const out = await decoded(res);
    expect(out.kind).toBe("activated");
    if (out.kind !== "activated") return;
    expect(out.id).toMatch(/^rd_/);
    expect(out.attemptId).toMatch(/^at_/);
  });

  it("200 resubmit decodes to existing carrying the owner's parsed manifest", async () => {
    const first = await post("/api/readings", { url: "https://contract.test/dup", email: false });
    const { id } = (await first.json()) as { id: string };
    const second = await post("/api/readings", { url: "https://contract.test/dup", email: false });
    expect(second.status).toBe(200);
    const out = await decoded(second);
    expect(out.kind).toBe("existing");
    if (out.kind !== "existing") return;
    expect(out.id).toBe(id);
    expect(out.manifest?.id).toBe(id);
    expect(out.manifest?.status).toBe("pending");
  });

  it("409 active-attempt conflict decodes to conflict (no id on the wire)", async () => {
    const submit = await post("/api/readings", { url: "https://contract.test/busy", email: false });
    const { id } = (await submit.json()) as { id: string };
    const res = await post(`/api/readings/${id}/reprocess`, {});
    expect(res.status).toBe(409);
    const out = await decoded(res);
    expect(out).toEqual({
      kind: "conflict",
      reason: "active_attempt",
      message: "reading already has an active attempt",
    });
  });

  it("409 initializing owner decodes to initializing with the owner's id", async () => {
    // An initializing owner is a by-url pointer whose manifest is not written
    // yet, still inside the grace window.
    const url = "https://contract.test/initializing";
    const owner = mintReadingId();
    const store = testReadingStore(env as unknown as Env);
    await store.writeByUrlPointer(await sha256Hex(url), {
      id: owner,
      key_prefix: buildKeyPrefix(owner, new Date().toISOString()),
    });
    const res = await post("/api/readings", { url, email: false });
    expect(res.status).toBe(409);
    const out = await decoded(res);
    expect(out).toEqual({ kind: "initializing", id: owner });
  });

  it("404 reprocess of an unknown id decodes to not_found", async () => {
    const res = await post(`/api/readings/${mintReadingId()}/reprocess`, {});
    expect(res.status).toBe(404);
    expect(await decoded(res)).toEqual({ kind: "not_found" });
  });

  it("503 with the queue unbound decodes to unavailable", async () => {
    (env as unknown as { READING_JOBS: Queue<ProcessReadingEnvelopeV1> | undefined }).READING_JOBS =
      undefined;
    const res = await post("/api/readings", { url: "https://contract.test/unbound", email: false });
    expect(res.status).toBe(503);
    const out = await decoded(res);
    expect(out.kind).toBe("unavailable");
    if (out.kind !== "unavailable") return;
    expect(out.message).toContain("READING_JOBS");
  });
});
