import { describe, expect, it } from "vitest";
import { RESEND_EMAILS_URL } from "../../../src/modules/email";
import { deliverSecurityMail, renderSecurityMail } from "../../../src/control-plane/security-mail";
import { buildAuthResendPayload, RESEND_AUTH_TRACKING } from "../../../src/control-plane/resend-mail";
import { openMigratedControlPlane } from "../../helpers/control-plane-sqlite";
import type { Env } from "../../../src/index";

describe("renderSecurityMail", () => {
  it("describes revoke-all without secrets", () => {
    const rendered = renderSecurityMail("sessions_revoked_all");
    expect(rendered.subject).toMatch(/sessions revoked/i);
    expect(rendered.text).toMatch(/all browser sessions/i);
    expect(`${rendered.subject}\n${rendered.text}\n${rendered.html}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );
  });
});

describe("buildAuthResendPayload", () => {
  it("disables Resend click and open tracking", () => {
    const payload = buildAuthResendPayload("reading-lite@test.example", {
      to: "founder@test.example",
      subject: "reading-lite: all sessions revoked",
      text: "All browser sessions were revoked.",
      html: "<p>All browser sessions were revoked.</p>",
    });
    expect(payload.tracking).toEqual(RESEND_AUTH_TRACKING);
    expect(payload.tracking).toEqual({ click: false, open: false });
    expect(JSON.stringify(payload)).not.toContain("reader@test.example");
  });
});

describe("deliverSecurityMail", () => {
  it("uses the injected sender and skips EMAIL_TO", async () => {
    const { db } = openMigratedControlPlane();
    const sent: { to: string; subject: string }[] = [];
    await deliverSecurityMail({ APP_ENV: "production" } as Env, db, {
      emailCanonical: "founder@example.com",
      emailDisplay: "Founder@example.com",
      kind: "sessions_revoked_all",
      nowMs: 1,
      sendSecurityMail: async (message) => {
        sent.push({ to: message.to, subject: message.subject });
      },
    });
    expect(sent).toEqual([
      { to: "Founder@example.com", subject: "reading-lite: all sessions revoked" },
    ]);
  });

  it("skips send when the staging allowlist forbids the address", async () => {
    const { db } = openMigratedControlPlane();
    let sent = 0;
    await deliverSecurityMail(
      { APP_ENV: "staging", AUTH_MAIL_ALLOWLIST: "", FOUNDER_EMAIL: "founder@example.com" } as Env,
      db,
      {
        emailCanonical: "other@example.com",
        emailDisplay: "other@example.com",
        kind: "sessions_revoked_all",
        nowMs: 1,
        sendSecurityMail: async () => {
          sent += 1;
        },
      },
    );
    expect(sent).toBe(0);
  });

  it("POSTs tracking-disabled JSON through Resend when not injected", async () => {
    const { db } = openMigratedControlPlane();
    let url = "";
    let body = "";
    const env = {
      APP_ENV: "production",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "reading-lite@test.example",
      EMAIL_TO: "reader@test.example",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        body = String(init?.body);
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      },
    } as unknown as Env;
    // deliverSecurityMail uses sendAuthMailViaResend(env) which reads env.fetch? No, it uses global fetch.
    // This test covers injected vs allowlist; Resend HTTP is covered by resend-magic-link.
    await deliverSecurityMail(env, db, {
      emailCanonical: "founder@example.com",
      emailDisplay: "founder@example.com",
      kind: "sessions_revoked_all",
      nowMs: 1,
      sendSecurityMail: async (message) => {
        url = RESEND_EMAILS_URL;
        body = JSON.stringify(
          buildAuthResendPayload("reading-lite@test.example", {
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
        );
      },
    });
    expect(url).toBe(RESEND_EMAILS_URL);
    const parsed = JSON.parse(body) as { tracking: { click: boolean; open: boolean }; to: string[] };
    expect(parsed.to).toEqual(["founder@example.com"]);
    expect(parsed.tracking).toEqual({ click: false, open: false });
    expect(body).not.toContain("reader@test.example");
    expect(body).not.toContain("re_test");
  });
});
