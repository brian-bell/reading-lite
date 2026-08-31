import { describe, expect, it } from "vitest";
import {
  buildMagicLinkResendPayload,
  sendMagicLinkViaResend,
} from "../../../src/control-plane/resend-magic-link";
import { RESEND_EMAILS_URL } from "../../../src/modules/email";
import type { Env } from "../../../src/index";

const verifyUrl = "https://reading.test.example/auth/verify#ml_secret";

describe("buildMagicLinkResendPayload", () => {
  it("sends to the delivery address with a plaintext URL, never EMAIL_TO, and tracking disabled", () => {
    const payload = buildMagicLinkResendPayload(
      "reading-lite@test.example",
      "Invited@test.example",
      verifyUrl,
    );
    expect(payload.from).toBe("reading-lite@test.example");
    expect(payload.to).toEqual(["Invited@test.example"]);
    expect(payload.text).toEqual(expect.stringContaining(verifyUrl));
    expect(payload.tracking).toEqual({ click: false, open: false });
    expect(JSON.stringify(payload)).not.toContain("reader@test.example");
    expect(JSON.stringify(payload)).not.toContain("EMAIL_TO");
  });
});

describe("sendMagicLinkViaResend", () => {
  it("POSTs the delivery address to Resend and does not use EMAIL_TO", async () => {
    const env = {
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "reading-lite@test.example",
      EMAIL_TO: "reader@test.example",
    } as Env;
    let url = "";
    let body = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      body = String(init?.body);
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    };
    await sendMagicLinkViaResend(env, "founder@test.example", verifyUrl, fetchImpl);
    expect(url).toBe(RESEND_EMAILS_URL);
    const parsed = JSON.parse(body) as { to: string[]; text: string; tracking?: { click: boolean; open: boolean } };
    expect(parsed.to).toEqual(["founder@test.example"]);
    expect(parsed.text).toContain(verifyUrl);
    expect(parsed.tracking).toEqual({ click: false, open: false });
    expect(body).not.toContain("reader@test.example");
    expect(body).not.toContain("re_test");
  });

  it("throws when Resend rejects the message", async () => {
    const env = {
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "reading-lite@test.example",
    } as Env;
    await expect(
      sendMagicLinkViaResend(env, "founder@test.example", verifyUrl, async () => new Response("bad", { status: 400 })),
    ).rejects.toThrow(/Resend rejected/);
  });

  it("refuses to send without RESEND_API_KEY", async () => {
    const env = { RESEND_API_KEY: "", EMAIL_FROM: "reading-lite@test.example", EMAIL_TO: "reader@test.example" } as Env;
    await expect(sendMagicLinkViaResend(env, "founder@test.example", verifyUrl, async () => new Response("no"))).rejects.toThrow(
      /RESEND_API_KEY/,
    );
  });
});
