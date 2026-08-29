import type { Context } from "hono";
import { AuthChallengeBodySchema, AuthRedeemBodySchema } from "../schemas/api";
import { LOGIN_PURPOSE } from "./constants";
import { admitAuthSend } from "./auth-rate-guard";
import { issueLoginChallenge } from "./challenges";
import { canonicalizeEmail } from "./email";
import { logAuthEvent } from "./auth-log";
import { readAuthRoots } from "./auth-root";
import { clearSessionCookieHeader, sessionCookieHeader } from "./cookies";
import { fromD1, type ControlPlaneDb } from "./db";
import { isAuthMailAllowed } from "./mail-allowlist";
import {
  buildMagicLinkVerifyUrl,
  latestLocalMagicLink,
  publicWebBase,
  renderMagicLinkMail,
  resolveMagicLinkDelivery,
  storeLocalMagicLink,
  type SendMagicLink,
} from "./magic-link-mail";
import { sendMagicLinkViaResend } from "./resend-magic-link";
import { isLoopbackHost, isSameOriginRequest } from "./origin";
import { parseRedemptionId, redeemLoginChallenge } from "./redeem";
import { authenticateSession, revokeSession } from "./sessions";
import { sanitizeUserAgent } from "./user-agent";
import type { RandomBytes } from "./credential";
import type { UuidSource } from "./ids";
import type { AppBindings } from "../middleware";

export interface AuthRuntime {
  sendMagicLink?: SendMagicLink;
  randomBytes?: RandomBytes;
  newUuid?: UuidSource;
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

  const admitted = await admitAuthSend(c.env, c.req.raw, emailCanonical);
  if (admitted === "deny") {
    logAuthEvent("magic_link_rate_limited");
    return jsonAuth({ ok: true }, 200);
  }

  if (!isAuthMailAllowed(c.env, emailCanonical)) {
    logAuthEvent("magic_link_delivery_skipped");
    return jsonAuth({ ok: true }, 200);
  }

  const liveBeforeIssue = await listLiveLoginChallenges(db, emailCanonical);
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
    logAuthEvent("magic_link_issued", {
      email: issued.deliveryEmail,
      challenge_id: issued.challengeId,
    });
  } catch {
    await restoreLiveLoginChallenges(db, issued.challengeId, liveBeforeIssue);
    logAuthEvent("magic_link_delivery_failed", { email: issued.deliveryEmail, challenge_id: issued.challengeId });
  }

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

  const result = await redeemLoginChallenge(db, {
    credential: parsed.data.credential,
    redemptionId,
    nowMs,
    authRoot: roots.authRoot,
    ...(roots.previousAuthRoot ? { previousAuthRoot: roots.previousAuthRoot } : {}),
    userAgentLabel: sanitizeUserAgent(c.req.header("user-agent")),
    randomBytes: runtime.randomBytes,
    newUuid: runtime.newUuid,
  });

  if (result.kind === "invalid") return jsonAuth({ error: "unauthorized" }, 401);
  if (result.kind === "conflict") return jsonAuth({ error: "challenge already claimed" }, 409);
  if (result.kind === "forbidden") return jsonAuth({ error: "forbidden" }, 403);

  logAuthEvent("magic_link_redeemed", { email: result.emailDisplay, session_id: result.sessionId });
  return jsonAuth(
    {
      tenant_id: String(result.userId),
      user_id: String(result.userId),
      email: result.emailDisplay,
      principal: "session",
    },
    200,
    { "set-cookie": sessionCookieHeader(result.credential) },
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

async function listLiveLoginChallenges(
  db: ControlPlaneDb,
  emailCanonical: string,
): Promise<{ id: string; state: string }[]> {
  return db.all<{ id: string; state: string }>(
    `SELECT id, state FROM auth_challenges
     WHERE email_canonical = ? AND purpose = ? AND state IN ('issued', 'claimed')`,
    emailCanonical,
    LOGIN_PURPOSE,
  );
}

/** Roll back an unused issued challenge after delivery failure. */
export async function restoreLiveLoginChallenges(
  db: ControlPlaneDb,
  newChallengeId: string,
  snapshot: { id: string; state: string }[],
): Promise<void> {
  try {
    // Skip the whole rollback unless this unused issued row is still unused.
    // A concurrent redeem may have claimed it after Resend actually delivered.
    const revokedNew = await db.run(
      `UPDATE auth_challenges SET state = 'revoked' WHERE id = ? AND state = 'issued'`,
      newChallengeId,
    );
    if (revokedNew.changes === 0) return;
    const statements = snapshot
      .filter((row) => row.id !== newChallengeId)
      .map((row) => ({
        sql: `UPDATE auth_challenges SET state = ? WHERE id = ? AND state = 'revoked'`,
        params: [row.state, row.id],
      }));
    await db.batch(statements);
  } catch {
    // Delivery already failed; keep the generic 200.
  }
}
