import { describe, expect, it } from "vitest";
import { MAGIC_LINK_VERIFY_PATH } from "../../../src/control-plane/constants";
import {
  buildMagicLinkVerifyUrl,
  publicWebBase,
  resolveMagicLinkDelivery,
} from "../../../src/control-plane/magic-link-mail";

const CONFIGURED_BASE = "https://readinglite.ai/";

describe("buildMagicLinkVerifyUrl", () => {
  it("points at the same-origin /auth/verify fragment URL", () => {
    expect(MAGIC_LINK_VERIFY_PATH).toBe("/auth/verify");
    expect(buildMagicLinkVerifyUrl("https://readinglite.ai/", "ml_abc.def")).toBe(
      "https://readinglite.ai/auth/verify#ml_abc.def",
    );
    expect(buildMagicLinkVerifyUrl("https://readinglite.ai/", "ml_abc.def", { purpose: "email_change" })).toBe(
      "https://readinglite.ai/auth/verify?purpose=email_change#ml_abc.def",
    );
  });
});

const STAGING_BASE = "https://staging.readinglite.ai/";

describe("publicWebBase", () => {
  it.each([
    // Production base: every public host mails back to itself.
    [CONFIGURED_BASE, "https://readinglite.ai", "https://readinglite.ai"],
    [CONFIGURED_BASE, "https://readinglite.app", "https://readinglite.app"],
    [CONFIGURED_BASE, "https://staging.readinglite.ai", "https://staging.readinglite.ai"],
    [CONFIGURED_BASE, "https://staging.readinglite.app", "https://staging.readinglite.app"],
    // Retired new-frontend preview hosts (ADR 0003) and a lookalike fall back to the base.
    [CONFIGURED_BASE, "https://next.readinglite.ai", "https://readinglite.ai"],
    [STAGING_BASE, "https://next-staging.readinglite.ai", "https://staging.readinglite.ai"],
    [CONFIGURED_BASE, "https://next.staging.readinglite.ai", "https://readinglite.ai"],
    // Staging base: staging hosts mail back to themselves, the legacy host to the base.
    [STAGING_BASE, "https://staging.readinglite.ai", "https://staging.readinglite.ai"],
    [STAGING_BASE, "https://staging.readinglite.app", "https://staging.readinglite.app"],
    [STAGING_BASE, "https://reading-lite-staging.bbell.dev", "https://staging.readinglite.ai"],
  ])("with base %s, a login arriving at %s mails back to %s", (base, host, expected) => {
    expect(publicWebBase(base, `${host}/api/auth/request`)).toBe(expected);
  });

  it("falls back to WEB_BASE_URL for an unknown or spoofed request host", () => {
    expect(publicWebBase(CONFIGURED_BASE, "https://attacker.example/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://reading-lite.bbell.dev/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://reading-lite-staging.bbell.dev/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://www.readinglite.ai/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://www.readinglite.app/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://www.staging.readinglite.ai/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "not a url")).toBe("https://readinglite.ai");
  });

  it("leaves loopback requests on the configured base", () => {
    expect(publicWebBase("http://127.0.0.1:5174", "http://127.0.0.1:8787/api/auth/request")).toBe(
      "http://127.0.0.1:5174",
    );
  });

  it("still derives the origin from the request when no base is configured", () => {
    expect(publicWebBase(undefined, "https://staging.readinglite.ai/api/auth/request")).toBe(
      "https://staging.readinglite.ai",
    );
    expect(publicWebBase("   ", "https://staging.readinglite.ai/api/auth/request")).toBe(
      "https://staging.readinglite.ai",
    );
    expect(publicWebBase(undefined, "not a url")).toBe("");
  });
});

describe("resolveMagicLinkDelivery", () => {
  it("uses Resend on staging/production even if a local sink flag is set", () => {
    expect(resolveMagicLinkDelivery({ APP_ENV: "staging", LOCAL_MAIL_SINK: "1" }, {}).kind).toBe("resend");
    expect(resolveMagicLinkDelivery({ APP_ENV: "production" }, {}).kind).toBe("resend");
  });

  it("keeps the local mail sink for non-cloud environments", () => {
    expect(resolveMagicLinkDelivery({ APP_ENV: "local", LOCAL_MAIL_SINK: "1" }, {}).kind).toBe("local_sink");
    expect(resolveMagicLinkDelivery({ APP_ENV: "test", LOCAL_MAIL_SINK: "1" }, {}).kind).toBe("local_sink");
    expect(resolveMagicLinkDelivery({ APP_ENV: "local" }, {}).kind).toBe("unavailable");
  });

  it("prefers an injected sender", () => {
    const send = async () => {};
    const resolved = resolveMagicLinkDelivery({ APP_ENV: "production" }, { sendMagicLink: send });
    expect(resolved).toEqual({ kind: "injected", send });
  });
});
