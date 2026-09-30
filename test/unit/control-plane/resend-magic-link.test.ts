import { describe, expect, it } from "vitest";
import { sendMagicLinkViaResend } from "../../../src/control-plane/resend-magic-link";
import { RESEND_EMAILS_URL } from "../../../src/modules/email";
import type { Env } from "../../../src/index";

const verifyUrl = "https://reading.test.example/auth/verify#ml_secret";

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
    const parsed = JSON.parse(body) as { to: string[]; text: string };
    expect(parsed.to).toEqual(["founder@test.example"]);
    expect(parsed.text).toContain(verifyUrl);
    expect("tracking" in parsed).toBe(false);
    expect(body).not.toContain("reader@test.example");
    expect(body).not.toContain("re_test");
  });

  it("names Resend's error in the rejection so the auth log can carry it", async () => {
    const env = { RESEND_API_KEY: "re_test", EMAIL_FROM: "reading-lite@test.example" } as Env;
    await expect(
      sendMagicLinkViaResend(
        env,
        "founder@test.example",
        verifyUrl,
        async () =>
          new Response(JSON.stringify({ statusCode: 403, name: "restricted_api_key", message: "no" }), { status: 403 }),
      ),
    ).rejects.toThrow("Resend rejected auth mail (403 restricted_api_key)");
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
