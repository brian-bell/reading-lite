import { describe, expect, it } from "vitest";
import { MAGIC_LINK_VERIFY_PATH } from "../../../src/control-plane/constants";
import {
  buildMagicLinkVerifyUrl,
  publicWebBase,
  resolveMagicLinkDelivery,
} from "../../../src/control-plane/magic-link-mail";

const CONFIGURED_BASE = "https://reading-lite.bbell.dev/";

describe("buildMagicLinkVerifyUrl", () => {
  it("points at the same-origin /auth/verify fragment URL", () => {
    expect(MAGIC_LINK_VERIFY_PATH).toBe("/auth/verify");
    expect(buildMagicLinkVerifyUrl("https://reading-lite.bbell.dev/", "ml_abc.def")).toBe(
      "https://reading-lite.bbell.dev/auth/verify#ml_abc.def",
    );
    expect(buildMagicLinkVerifyUrl("https://reading-lite.bbell.dev/", "ml_abc.def", { purpose: "email_change" })).toBe(
      "https://reading-lite.bbell.dev/auth/verify?purpose=email_change#ml_abc.def",
    );
  });
});

describe("publicWebBase", () => {
  it("mails the link back to the public host the login started on", () => {
    expect(publicWebBase(CONFIGURED_BASE, "https://reading-lite.bbell.dev/api/auth/request")).toBe(
      "https://reading-lite.bbell.dev",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://bbookmarks.com/api/auth/request")).toBe(
      "https://bbookmarks.com",
    );
  });

  it("produces a verify URL on the host the request arrived at", () => {
    const base = publicWebBase(CONFIGURED_BASE, "https://bbookmarks.com/api/auth/request");
    expect(buildMagicLinkVerifyUrl(base, "ml_abc.def")).toBe("https://bbookmarks.com/auth/verify#ml_abc.def");
  });

  it("falls back to WEB_BASE_URL for an unknown or spoofed request host", () => {
    expect(publicWebBase(CONFIGURED_BASE, "https://attacker.example/api/auth/request")).toBe(
      "https://reading-lite.bbell.dev",
    );
    expect(publicWebBase(CONFIGURED_BASE, "https://www.bbookmarks.com/api/auth/request")).toBe(
      "https://reading-lite.bbell.dev",
    );
    expect(publicWebBase(CONFIGURED_BASE, "not a url")).toBe("https://reading-lite.bbell.dev");
  });

  it("leaves loopback and staging requests on the configured base", () => {
    expect(publicWebBase("http://127.0.0.1:5173", "http://127.0.0.1:8787/api/auth/request")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(
      publicWebBase(
        "https://reading-lite-staging.bbell.dev/",
        "https://reading-lite-staging.bbell.dev/api/auth/request",
      ),
    ).toBe("https://reading-lite-staging.bbell.dev");
  });

  it("still derives the origin from the request when no base is configured", () => {
    expect(publicWebBase(undefined, "https://reading-lite-staging.bbell.dev/api/auth/request")).toBe(
      "https://reading-lite-staging.bbell.dev",
    );
    expect(publicWebBase("   ", "https://reading-lite-staging.bbell.dev/api/auth/request")).toBe(
      "https://reading-lite-staging.bbell.dev",
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
