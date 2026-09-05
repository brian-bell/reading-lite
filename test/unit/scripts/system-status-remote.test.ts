import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getPlatformProxy: vi.fn(),
  fetch: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("wrangler", () => ({ getPlatformProxy: mocks.getPlatformProxy }));
import { remoteSpendStatus } from "../../../scripts/system-lib/status";
const tenant = "usr_550e8400-e29b-41d4-a716-446655440000";
const status = {
  dayKey: "2026-09-05",
  observedAtMs: 100,
  resetAtMs: 200,
  globalChargedMicrodollars: 42,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.dispose.mockResolvedValue(undefined);
  mocks.getPlatformProxy.mockResolvedValue({
    env: { STATUS: { fetch: mocks.fetch } },
    dispose: mocks.dispose,
  });
});
describe("remote accounting transport", () => {
  it.each(["staging", "production"] as const)(
    "uses the explicit %s remote service and disposes the session",
    async (environment) => {
      mocks.fetch.mockResolvedValue(Response.json(status));
      expect(await remoteSpendStatus(environment)).toEqual(status);
      expect(mocks.getPlatformProxy).toHaveBeenCalledWith({
        environment,
        persist: false,
        remoteBindings: true,
        configPath: expect.stringMatching(/system-lib\/wrangler-status.toml$/),
      });
      expect(mocks.fetch).toHaveBeenCalledWith("https://operator/status");
      expect(mocks.dispose).toHaveBeenCalledOnce();
    },
  );
  it("validates tenant attribution", async () => {
    mocks.fetch.mockResolvedValue(Response.json(status));
    await expect(remoteSpendStatus("staging", tenant)).rejects.toThrow(
      "Accounting unavailable",
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it.each([
    Response.json({ ...status, globalChargedMicrodollars: -1 }),
    new Response("secret-token", { status: 503 }),
  ])("fails closed on malformed or failed response", async (response) => {
    mocks.fetch.mockResolvedValue(response);
    await expect(remoteSpendStatus("staging")).rejects.toThrow(
      "Accounting unavailable",
    );
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("redacts proxy startup failures", async () => {
    mocks.getPlatformProxy.mockRejectedValue(new Error("secret-token"));
    await expect(remoteSpendStatus("staging")).rejects.toThrow(
      "Accounting unavailable",
    );
  });
});
