import type { Context } from "hono";
import { AuthChallengeBodySchema, AuthRedeemBodySchema, CSRF_HEADER } from "../schemas/api";
import { EMAIL_CHANGE_PURPOSE, LOGIN_PURPOSE, type AuthChallengePurpose } from "./constants";
import { admitAuthIp, admitAuthSend } from "./auth-rate-guard";
import { issueEmailChangeChallenge, issueLoginChallenge, lookupChallenge } from "./challenges";
import { canonicalizeEmail } from "./email";
import { resolveLoginEligibility } from "./eligibility";
import { logAuthEvent } from "./auth-log";
import { readAuthRoots } from "./auth-root";
import { clearSessionCookieHeader, readSessionCookie, sessionCookieHeader } from "./cookies";
import { fromD1, type ControlPlaneDb } from "./db";
import { isAuthMailAllowed } from "./mail-allowlist";
import {
  buildMagicLinkVerifyUrl,
  latestLocalMagicLink,
  publicWebBase,
  renderEmailChangeMagicLinkMail,
  renderMagicLinkMail,
  resolveMagicLinkDelivery,
  storeLocalMagicLink,
  type SendMagicLink,
} from "./magic-link-mail";
import { sendMagicLinkViaResend } from "./resend-magic-link";
import { sendAuthMailViaResend } from "./resend-mail";
import { isLoopbackHost, isSameOriginRequest } from "./origin";
import { parseRedemptionId, redeemLoginChallenge } from "./redeem";
import { verifyCsrfToken } from "./csrf";
import { authenticateSession, revokeSession } from "./sessions";
import { deliverSecurityMail, type SendSecurityMail } from "./security-mail";
import { sanitizeUserAgent } from "./user-agent";
import { parseCredential, type RandomBytes } from "./credential";
import { parseChallengeId, parseSessionId, type UuidSource } from "./ids";
import type { AppBindings } from "../middleware";

export interface AuthRuntime {
  sendMagicLink?: SendMagicLink;
  sendSecurityMail?: SendSecurityMail;
  randomBytes?: RandomBytes;
  newUuid?: UuidSource;
  markMailSent?: (args: { challengeId: string; nowMs: number }) => Promise<void>;
}

const ChallengeBodySchema = AuthChallengeBodySchema;
const RedeemBodySchema = AuthRedeemBodySchema;

export function jsonAuth(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function requireSameOrigin(c: Context<AppBindings>): boolean {
  return isSameOriginRequest({
    origin: c.req.header("origin"),
    url: c.req.url,
    webBaseUrl: c.env.WEB_BASE_URL,
  });
}

export async function handleAuthChallenge(
  c: Context<AppBindings>,
  nowMs: number,
  runtime: AuthRuntime,
): Promise<Response> {
  if (!requireSameOrigin(c)) return jsonAuth({ error: "forbidden origin" }, 403);
  const json = await c.req.json().catch(() => null);
  const parsed = ChallengeBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  let emailCanonical: string;
  try {
    emailCanonical = canonicalizeEmail(parsed.data.email);
  } catch {
    return jsonAuth({ error: "invalid body" }, 400);
  }

  if (!c.env.CONTROL_PLANE || !c.env.AUTH_ROOT_SECRET) {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const db = fromD1(c.env.CONTROL_PLANE);
  let roots;
  try {
    roots = readAuthRoots(c.env);
  } catch {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const ipAdmitted = await admitAuthIp(c.env, c.req.raw);
  if (ipAdmitted === "deny") {
    logAuthEvent("magic_link_rate_limited");
    return jsonAuth({ ok: true }, 200);
  }

  if (!isAuthMailAllowed(c.env, emailCanonical)) {
    logAuthEvent("magic_link_delivery_skipped");
    return jsonAuth({ ok: true }, 200);
  }

  const eligibility = await resolveLoginEligibility(db, emailCanonical, nowMs);
  if (eligibility.kind === "ineligible") {
    logAuthEvent("magic_link_skipped", { email: parsed.data.email });
    return jsonAuth({ ok: true }, 200);
  }

  const sendAdmitted = await admitAuthSend(c.env, emailCanonical);
  if (sendAdmitted === "deny") {
    logAuthEvent("magic_link_rate_limited");
    return jsonAuth({ ok: true }, 200);
  }

  const liveBeforeIssue = await listLiveChallenges(db, emailCanonical, LOGIN_PURPOSE);
  const issued = await issueLoginChallenge(db, {
    emailCanonical,
    emailDisplayRequested: parsed.data.email.trim(),
    nowMs,
    authRoot: roots.authRoot,
    randomBytes: runtime.randomBytes,
    newUuid: runtime.newUuid,
  });

  if (issued.kind !== "issued") {
    logAuthEvent("magic_link_skipped", { email: parsed.data.email });
    return jsonAuth({ ok: true }, 200);
  }

  const verifyUrl = buildMagicLinkVerifyUrl(publicWebBase(c.env.WEB_BASE_URL, c.req.url), issued.credential);
  const rendered = renderMagicLinkMail(verifyUrl);
  try {
    const delivery = resolveMagicLinkDelivery(c.env, runtime);
    if (delivery.kind === "injected") {
      await delivery.send({ to: issued.deliveryEmail, subject: rendered.subject, verifyUrl });
    } else if (delivery.kind === "local_sink") {
      await storeLocalMagicLink(db, {
        to: issued.deliveryEmail,
        subject: rendered.subject,
        verifyUrl,
        nowMs,
      });
    } else if (delivery.kind === "resend") {
      await sendMagicLinkViaResend(c.env, issued.deliveryEmail, verifyUrl);
    } else {
      throw new Error("magic-link delivery is not configured");
    }
  } catch {
    await restoreLiveChallenges(db, issued.challengeId, liveBeforeIssue);
    logAuthEvent("magic_link_delivery_failed", { email: issued.deliveryEmail, challenge_id: issued.challengeId });
    return jsonAuth({ ok: true }, 200);
  }

  await rememberMailSentMarker(async () => {
    if (runtime.markMailSent) {
      await runtime.markMailSent({ challengeId: issued.challengeId, nowMs });
      return;
    }
    await markChallengeMailSent(db, { challengeId: issued.challengeId, nowMs });
  });
  logAuthEvent("magic_link_issued", {
    email: issued.deliveryEmail,
    challenge_id: issued.challengeId,
  });

  return jsonAuth({ ok: true }, 200);
}

export async function handleAuthRedeem(
  c: Context<AppBindings>,
  nowMs: number,
  runtime: AuthRuntime,
): Promise<Response> {
  if (!requireSameOrigin(c)) return jsonAuth({ error: "forbidden origin" }, 403);
  const json = await c.req.json().catch(() => null);
  const parsed = RedeemBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);
  const redemptionId = parseRedemptionId(parsed.data.redemption_id);
  if (!redemptionId) return jsonAuth({ error: "invalid body" }, 400);

  if (!c.env.CONTROL_PLANE || !c.env.AUTH_ROOT_SECRET) {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const db = fromD1(c.env.CONTROL_PLANE);
  let roots;
  try {
    roots = readAuthRoots(c.env);
  } catch {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const cookieHeader = c.req.header("cookie");
  const sessionCookiePresent = readSessionCookie(cookieHeader) !== null;
  const existing = await authenticateSession(db, {
    cookieHeader,
    authRoot: roots.authRoot,
    ...(roots.previousAuthRoot ? { previousAuthRoot: roots.previousAuthRoot } : {}),
    nowMs,
  });

  const presented = parseCredential(parsed.data.credential, parseChallengeId);
  if (presented) {
    const preview = await lookupChallenge(db, presented.selector);
    if (preview?.purpose === EMAIL_CHANGE_PURPOSE) {
      if (!sessionCookiePresent) return jsonAuth({ error: "unauthorized" }, 401);
      if (existing.kind !== "ok") return jsonAuth({ error: "forbidden" }, 403);
      const csrfOk = await verifyCsrfToken({
        token: c.req.header(CSRF_HEADER),
        sessionId: existing.principal.sessionId,
        authRoot: roots.authRoot,
        ...(roots.previousAuthRoot ? { previousAuthRoot: roots.previousAuthRoot } : {}),
      });
      if (!csrfOk) return jsonAuth({ error: "forbidden" }, 403);
    }
  }

  const result = await redeemLoginChallenge(db, {
    credential: parsed.data.credential,
    redemptionId,
    nowMs,
    authRoot: roots.authRoot,
    ...(roots.previousAuthRoot ? { previousAuthRoot: roots.previousAuthRoot } : {}),
    userAgentLabel: sanitizeUserAgent(c.req.header("user-agent")),
    sessionCookiePresent,
    ...(existing.kind === "ok" ? { stepUpSessionId: existing.principal.sessionId } : {}),
    randomBytes: runtime.randomBytes,
    newUuid: runtime.newUuid,
  });

  if (result.kind === "invalid" || result.kind === "unauthenticated") {
    return jsonAuth({ error: "unauthorized" }, 401);
  }
  if (result.kind === "conflict") {
    const error =
      result.reason === "email_taken" ? "email change could not be completed" : "challenge already claimed";
    return jsonAuth({ error }, 409);
  }
  if (result.kind === "forbidden") return jsonAuth({ error: "forbidden" }, 403);

  if (result.securityNotify) {
    await deliverSecurityMail(c.env, {
      emailCanonical: result.securityNotify.emailCanonical,
      emailDisplay: result.securityNotify.emailDisplay,
      kind: result.securityNotify.kind,
      nowMs,
      sendSecurityMail: runtime.sendSecurityMail,
    });
  }

  logAuthEvent("magic_link_redeemed", { email: result.emailDisplay, session_id: result.sessionId });
  const extraHeaders: HeadersInit = {};
  if (result.credential) {
    extraHeaders["set-cookie"] = sessionCookieHeader(result.credential);
  }
  return jsonAuth(
    {
      tenant_id: String(result.userId),
      user_id: String(result.userId),
      email: result.emailDisplay,
      principal: "session",
    },
    200,
    extraHeaders,
  );
}

export async function handleAuthLogout(
  c: Context<AppBindings>,
  nowMs: number,
): Promise<Response> {
  if (!requireSameOrigin(c)) return jsonAuth({ error: "forbidden origin" }, 403);
  if (!c.env.CONTROL_PLANE || !c.env.AUTH_ROOT_SECRET) {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }
  let roots;
  try {
    roots = readAuthRoots(c.env);
  } catch {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }
  const db = fromD1(c.env.CONTROL_PLANE);
  const verdict = await authenticateSession(db, {
    cookieHeader: c.req.header("cookie"),
    authRoot: roots.authRoot,
    ...(roots.previousAuthRoot ? { previousAuthRoot: roots.previousAuthRoot } : {}),
    nowMs,
  });
  if (verdict.kind !== "ok") {
    return jsonAuth({ error: "unauthorized" }, 401, { "set-cookie": clearSessionCookieHeader() });
  }
  const csrfOk = await verifyCsrfToken({
    token: c.req.header(CSRF_HEADER),
    sessionId: verdict.principal.sessionId,
    authRoot: roots.authRoot,
    ...(roots.previousAuthRoot ? { previousAuthRoot: roots.previousAuthRoot } : {}),
  });
  if (!csrfOk) return jsonAuth({ error: "forbidden" }, 403);
  await revokeSession(db, verdict.principal.sessionId, nowMs, "logout");
  logAuthEvent("session_logout", { session_id: verdict.principal.sessionId });
  return jsonAuth({ ok: true }, 200, { "set-cookie": clearSessionCookieHeader() });
}

export async function handleDevMailbox(c: Context<AppBindings>): Promise<Response> {
  if (c.env.LOCAL_MAIL_SINK !== "1") return jsonAuth({ error: "not found" }, 404);
  let hostname = "";
  try {
    hostname = new URL(c.req.url).hostname;
  } catch {
    return jsonAuth({ error: "not found" }, 404);
  }
  if (!isLoopbackHost(hostname)) return jsonAuth({ error: "forbidden" }, 403);
  const emailRaw = c.req.query("email");
  if (!emailRaw) return jsonAuth({ error: "invalid query" }, 400);
  let emailCanonical: string;
  try {
    emailCanonical = canonicalizeEmail(emailRaw);
  } catch {
    return jsonAuth({ error: "invalid query" }, 400);
  }
  if (!c.env.CONTROL_PLANE) return jsonAuth({ error: "auth misconfigured" }, 500);
  const row = await latestLocalMagicLink(fromD1(c.env.CONTROL_PLANE), emailCanonical);
  if (!row) {
    const byDisplay = await latestLocalMagicLink(fromD1(c.env.CONTROL_PLANE), emailRaw.trim());
    if (!byDisplay) return jsonAuth({ error: "not found" }, 404);
    return jsonAuth({ to: byDisplay.to_email, verify_url: byDisplay.verify_url }, 200);
  }
  return jsonAuth({ to: row.to_email, verify_url: row.verify_url }, 200);
}

export async function handleEmailChangeRequest(
  c: Context<AppBindings>,
  nowMs: number,
  runtime: AuthRuntime,
): Promise<Response> {
  const json = await c.req.json().catch(() => null);
  const parsed = ChallengeBodySchema.safeParse(json);
  if (!parsed.success) return jsonAuth({ error: "invalid body" }, 400);

  let emailCanonical: string;
  try {
    emailCanonical = canonicalizeEmail(parsed.data.email);
  } catch {
    return jsonAuth({ error: "invalid body" }, 400);
  }

  if (!c.env.CONTROL_PLANE || !c.env.AUTH_ROOT_SECRET) {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const db = fromD1(c.env.CONTROL_PLANE);
  let roots;
  try {
    roots = readAuthRoots(c.env);
  } catch {
    return jsonAuth({ error: "auth misconfigured" }, 500);
  }

  const principal = c.get("principal");
  if (principal.kind !== "session") return jsonAuth({ error: "forbidden" }, 403);
  const sessionId = parseSessionId(principal.sessionId);
  if (!sessionId) return jsonAuth({ error: "unauthorized" }, 401);
  const current = await db.first<{ email_canonical: string }>(
    "SELECT email_canonical FROM users WHERE id = ?",
    String(principal.userId),
  );
  if (!current) return jsonAuth({ error: "unauthorized" }, 401);
  if (current.email_canonical === emailCanonical) {
    return jsonAuth({ ok: true }, 200);
  }

  const ipAdmitted = await admitAuthIp(c.env, c.req.raw);
  if (ipAdmitted === "deny") {
    logAuthEvent("magic_link_rate_limited");
    return jsonAuth({ ok: true }, 200);
  }

  if (!isAuthMailAllowed(c.env, emailCanonical)) {
    logAuthEvent("magic_link_delivery_skipped");
    return jsonAuth({ ok: true }, 200);
  }

  const sendAdmitted = await admitAuthSend(c.env, emailCanonical);
  if (sendAdmitted === "deny") {
    logAuthEvent("magic_link_rate_limited");
    return jsonAuth({ ok: true }, 200);
  }

  const liveBeforeIssue = await listLiveChallenges(db, emailCanonical, EMAIL_CHANGE_PURPOSE);
  const issued = await issueEmailChangeChallenge(db, {
    emailCanonical,
    emailDisplay: parsed.data.email.trim(),
    userId: principal.userId,
    sessionId,
    nowMs,
    authRoot: roots.authRoot,
    randomBytes: runtime.randomBytes,
    newUuid: runtime.newUuid,
  });

  if (issued.kind !== "issued") {
    logAuthEvent("magic_link_skipped", { email: parsed.data.email });
    return jsonAuth({ ok: true }, 200);
  }

  const verifyUrl = buildMagicLinkVerifyUrl(publicWebBase(c.env.WEB_BASE_URL, c.req.url), issued.credential, {
    purpose: EMAIL_CHANGE_PURPOSE,
  });
  const rendered = renderEmailChangeMagicLinkMail(verifyUrl);
  try {
    const delivery = resolveMagicLinkDelivery(c.env, runtime);
    if (delivery.kind === "injected") {
      await delivery.send({ to: issued.deliveryEmail, subject: rendered.subject, verifyUrl });
    } else if (delivery.kind === "local_sink") {
      await storeLocalMagicLink(db, {
        to: issued.deliveryEmail,
        subject: rendered.subject,
        verifyUrl,
        nowMs,
      });
    } else if (delivery.kind === "resend") {
      await sendAuthMailViaResend(c.env, {
        to: issued.deliveryEmail,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } else {
      throw new Error("magic-link delivery is not configured");
    }
  } catch {
    await restoreLiveChallenges(db, issued.challengeId, liveBeforeIssue);
    logAuthEvent("magic_link_delivery_failed", { email: issued.deliveryEmail, challenge_id: issued.challengeId });
    return jsonAuth({ ok: true }, 200);
  }

  await rememberMailSentMarker(async () => {
    if (runtime.markMailSent) {
      await runtime.markMailSent({ challengeId: issued.challengeId, nowMs });
      return;
    }
    await markChallengeMailSent(db, { challengeId: issued.challengeId, nowMs });
  });
  logAuthEvent("email_change_issued", {
    email: issued.deliveryEmail,
    challenge_id: issued.challengeId,
  });

  return jsonAuth({ ok: true }, 200);
}

export async function markChallengeMailSent(
  db: ControlPlaneDb,
  args: { challengeId: string; nowMs: number },
): Promise<void> {
  await db.run(
    `UPDATE auth_challenges SET mail_sent_at_ms = ? WHERE id = ? AND mail_sent_at_ms IS NULL`,
    args.nowMs,
    args.challengeId,
  );
}

/** Retry a successful-send mail marker. Never throws; the issued row stays live. */
export async function rememberMailSentMarker(mark: () => Promise<void>): Promise<void> {
  try {
    await mark();
  } catch {
    try {
      await mark();
    } catch {
      // Send already succeeded. Restoring would revoke the emailed secret.
    }
  }
}

async function listLiveChallenges(
  db: ControlPlaneDb,
  emailCanonical: string,
  purpose: AuthChallengePurpose,
): Promise<{ id: string; state: string; issued_at_ms: number }[]> {
  return db.all<{ id: string; state: string; issued_at_ms: number }>(
    `SELECT id, state, issued_at_ms FROM auth_challenges
     WHERE email_canonical = ? AND purpose = ? AND state IN ('issued', 'claimed')`,
    emailCanonical,
    purpose,
  );
}

/** Roll back an unused issued challenge after delivery failure. */
export async function restoreLiveChallenges(
  db: ControlPlaneDb,
  newChallengeId: string,
  snapshot: { id: string; state: string; issued_at_ms: number }[],
): Promise<void> {
  try {
    // Skip the whole rollback unless this unused issued row is still unused.
    // A concurrent redeem may have claimed it after Resend actually delivered.
    const revokedNew = await db.run(
      `UPDATE auth_challenges SET state = 'revoked' WHERE id = ? AND state = 'issued'`,
      newChallengeId,
    );
    if (revokedNew.changes === 0) return;

    const meta = await db.first<{ email_canonical: string; purpose: string }>(
      `SELECT email_canonical, purpose FROM auth_challenges WHERE id = ?`,
      newChallengeId,
    );
    if (!meta) return;

    const otherLive = await db.first<{ id: string }>(
      `SELECT id FROM auth_challenges
       WHERE email_canonical = ? AND purpose = ? AND state IN ('issued', 'claimed') AND id != ?`,
      meta.email_canonical,
      meta.purpose,
      newChallengeId,
    );
    if (otherLive) return;

    const snapshotIssuedIds = snapshot
      .filter((row) => row.id !== newChallengeId && row.state === "issued")
      .map((row) => row.id);

    const newestMarked = await db.first<{ id: string }>(
      `SELECT id FROM auth_challenges
       WHERE email_canonical = ? AND purpose = ? AND id != ?
         AND (mail_sent_at_ms IS NOT NULL OR claim_id IS NOT NULL)
       ORDER BY rowid DESC
       LIMIT 1`,
      meta.email_canonical,
      meta.purpose,
      newChallengeId,
    );
    if (newestMarked) {
      // Newest mailed wins. claim_id marks a used successor even when mail_sent_at_ms
      // never stuck and listLive missed it (consumed rows are not live).
      // restoreUnusedRevokedChallenge is a no-op when claim_id or consumed_at_ms is set.
      await restoreUnusedRevokedChallenge(db, newestMarked.id);
      return;
    }

    if (snapshotIssuedIds.length > 0) {
      // Send succeeded but mail_sent_at_ms never stuck. Treat listed issued ids as mailed.
      const newestSnapshotIssued = await newestChallengeId(db, snapshotIssuedIds);
      if (newestSnapshotIssued) await restoreUnusedRevokedChallenge(db, newestSnapshotIssued);
      return;
    }

    // Snapshot listed nothing live (a concurrent first send landed after list).
    // Restore the unused predecessor this issue actually revoked.
    const revokedPredecessor = await db.first<{ id: string }>(
      `SELECT id FROM auth_challenges
       WHERE email_canonical = ?
         AND purpose = ?
         AND id != ?
         AND state = 'revoked'
         AND claim_id IS NULL
         AND consumed_at_ms IS NULL
       ORDER BY rowid DESC
       LIMIT 1`,
      meta.email_canonical,
      meta.purpose,
      newChallengeId,
    );
    if (revokedPredecessor) await restoreUnusedRevokedChallenge(db, revokedPredecessor.id);
  } catch {
    // Delivery already failed; keep the generic 200.
  }
}

export const restoreLiveLoginChallenges = restoreLiveChallenges;

async function newestChallengeId(db: ControlPlaneDb, ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => "?").join(", ");
  const row = await db.first<{ id: string }>(
    `SELECT id FROM auth_challenges WHERE id IN (${placeholders}) ORDER BY rowid DESC LIMIT 1`,
    ...ids,
  );
  return row?.id ?? null;
}

async function restoreUnusedRevokedChallenge(db: ControlPlaneDb, challengeId: string): Promise<void> {
  await db.run(
    `UPDATE auth_challenges SET state = 'issued'
     WHERE id = ?
       AND state = 'revoked'
       AND claim_id IS NULL
       AND consumed_at_ms IS NULL`,
    challengeId,
  );
}
