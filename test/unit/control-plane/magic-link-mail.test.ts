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

describe("publicWebBase", () => {
  it("mails the link back to the public host the login started on", () => {
    expect(publicWebBase(CONFIGURED_BASE, "https://readinglite.ai/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://readinglite.app/api/auth/request")).toBe(
      "https://readinglite.app",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://staging.readinglite.ai/api/auth/request")).toBe(
      "https://staging.readinglite.ai",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://staging.readinglite.app/api/auth/request")).toBe(
      "https://staging.readinglite.app",
    );
  });

  it("mails new-frontend preview logins back to their preview host", () => {
    expect(publicWebBase(CONFIGURED_BASE, "https://next.readinglite.ai/api/auth/request")).toBe(
      "https://next.readinglite.ai",
    );
    expect(
      publicWebBase("https://staging.readinglite.ai/", "https://next-staging.readinglite.ai/api/auth/request"),
    ).toBe("https://next-staging.readinglite.ai");
    expect(publicWebBase(CONFIGURED_BASE, "https://next.staging.readinglite.ai/api/auth/request")).toBe(
      "https://readinglite.ai",
    );
  });

  it("produces a verify URL on the host the request arrived at", () => {
    const base = publicWebBase(CONFIGURED_BASE, "https://readinglite.ai/api/auth/request");
    expect(buildMagicLinkVerifyUrl(base, "ml_abc.def")).toBe("https://readinglite.ai/auth/verify#ml_abc.def");
    expect(
      buildMagicLinkVerifyUrl(publicWebBase(CONFIGURED_BASE, "https://readinglite.app/api/auth/request"), "ml_abc.def"),
    ).toBe("https://readinglite.app/auth/verify#ml_abc.def");
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
    expect(publicWebBase("http://127.0.0.1:5173", "http://127.0.0.1:8787/api/auth/request")).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("mails staging logins back to the staging host they arrived on", () => {
    const stagingBase = "https://staging.readinglite.ai/";
    expect(publicWebBase(stagingBase, "https://staging.readinglite.ai/api/auth/request")).toBe(
      "https://staging.readinglite.ai",
    );
    expect(publicWebBase(stagingBase, "https://staging.readinglite.app/api/auth/request")).toBe(
      "https://staging.readinglite.app",
    );
    expect(publicWebBase(stagingBase, "https://reading-lite-staging.bbell.dev/api/auth/request")).toBe(
      "https://staging.readinglite.ai",
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
