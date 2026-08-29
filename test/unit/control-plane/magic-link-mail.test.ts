import { describe, expect, it } from "vitest";
import { MAGIC_LINK_VERIFY_PATH } from "../../../src/control-plane/constants";
import {
  buildMagicLinkVerifyUrl,
  resolveMagicLinkDelivery,
} from "../../../src/control-plane/magic-link-mail";

describe("buildMagicLinkVerifyUrl", () => {
  it("points at the same-origin /auth/verify fragment URL", () => {
    expect(MAGIC_LINK_VERIFY_PATH).toBe("/auth/verify");
    expect(buildMagicLinkVerifyUrl("https://reading-lite.bbell.dev/", "ml_abc.def")).toBe(
      "https://reading-lite.bbell.dev/auth/verify#ml_abc.def",
    );
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
