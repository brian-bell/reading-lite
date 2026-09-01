import { describe, expect, it } from "vitest";
import { RESEND_EMAILS_URL } from "../../../src/modules/email";
import { latestLocalMagicLink, storeLocalMagicLink } from "../../../src/control-plane/magic-link-mail";
import { deliverSecurityMail, renderSecurityMail } from "../../../src/control-plane/security-mail";
import { buildAuthResendPayload } from "../../../src/control-plane/resend-mail";
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

  it("describes an email change without secrets", () => {
    const rendered = renderSecurityMail("email_changed");
    expect(rendered.subject).toMatch(/email changed/i);
    expect(rendered.text).toMatch(/login email/i);
    expect(`${rendered.subject}\n${rendered.text}\n${rendered.html}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );
  });

  it("describes an API key create without secrets", () => {
    const rendered = renderSecurityMail("api_token_created");
    expect(rendered.subject).toMatch(/API key created/i);
    expect(`${rendered.subject}\n${rendered.text}\n${rendered.html}`).not.toMatch(
      /secret|token|cookie|credential|authorization|hmac/i,
    );
  });
});

describe("buildAuthResendPayload", () => {
  it("omits tracking; click/open stay a domain setting", () => {
    const payload = buildAuthResendPayload("reading-lite@test.example", {
      to: "founder@test.example",
      subject: "reading-lite: all sessions revoked",
      text: "All browser sessions were revoked.",
      html: "<p>All browser sessions were revoked.</p>",
    });
    expect("tracking" in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("reader@test.example");
  });
});

describe("deliverSecurityMail", () => {
  it("uses the injected sender and skips EMAIL_TO", async () => {
    const sent: { to: string; subject: string }[] = [];
    await deliverSecurityMail({ APP_ENV: "production" } as Env, {
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
    let sent = 0;
    await deliverSecurityMail(
      { APP_ENV: "staging", AUTH_MAIL_ALLOWLIST: "", FOUNDER_EMAIL: "founder@example.com" } as Env,
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

  it("does not write local-sink security mail into the magic-link outbox", async () => {
    const { sqlite, db } = openMigratedControlPlane();
    const verifyUrl = "https://reading.test.example/auth/verify#ml_live";
    await storeLocalMagicLink(db, {
      to: "founder@example.com",
      subject: "Sign in to reading-lite",
      verifyUrl,
      nowMs: 1,
    });
    await deliverSecurityMail({ APP_ENV: "local", LOCAL_MAIL_SINK: "1" } as Env, {
      emailCanonical: "founder@example.com",
      emailDisplay: "founder@example.com",
      kind: "sessions_revoked_all",
      nowMs: 2,
    });
    const latest = await latestLocalMagicLink(db, "founder@example.com");
    expect(latest?.verify_url).toBe(verifyUrl);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dev_mail_outbox").get()).toEqual({ n: 1 });
  });

  it("POSTs JSON without a tracking key", async () => {
    let body = "";
    await deliverSecurityMail({ APP_ENV: "production" } as Env, {
      emailCanonical: "founder@example.com",
      emailDisplay: "founder@example.com",
      kind: "sessions_revoked_all",
      nowMs: 1,
      sendSecurityMail: async (message) => {
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
    const parsed = JSON.parse(body) as { to: string[] };
    expect(parsed.to).toEqual(["founder@example.com"]);
    expect("tracking" in parsed).toBe(false);
    expect(body).not.toContain("reader@test.example");
    expect(body).not.toContain(RESEND_EMAILS_URL);
  });
});
