import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

/**
 * Link sessions: after a link responder passes OTP step-up, they get a
 * short-lived, HMAC-signed cookie scoped to that one access token. This is
 * what authorises the rest of the link flow (view JD, upload, submit) without
 * a full account.
 */

const COOKIE = "rv_link_session";
const DRAFT_COOKIE = "rv_link_draft";
const TTL_MS = 60 * 60 * 1000; // 1 hour

function secret(): string {
  // Dedicated key isolates link-session signing from the auth library; falls
  // back to BETTER_AUTH_SECRET so existing deployments keep working.
  const s = process.env.LINK_SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error("LINK_SESSION_SECRET or BETTER_AUTH_SECRET is required.");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export async function issueLinkSession(accessTokenId: string): Promise<void> {
  const expires = Date.now() + TTL_MS;
  const payload = `${accessTokenId}.${expires}`;
  const value = `${payload}.${sign(payload)}`;
  const jar = await cookies();
  jar.set(COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

/**
 * Draft secrets. A saved draft is wrapped with a random per-link secret held
 * only in this browser, in its own httpOnly cookie scoped to the link's path
 * and living as long as the link. It is independent of the one-hour session,
 * so a responder who re-verifies after the session lapses still opens their
 * draft. An existing secret is never replaced, or the draft would be lost.
 */
export async function ensureDraftSecret(
  accessTokenId: string,
  rawToken: string,
  linkExpiresAt: Date,
): Promise<void> {
  if (await readDraftSecret(accessTokenId)) return;
  const maxAge = Math.floor((linkExpiresAt.getTime() - Date.now()) / 1000);
  if (maxAge <= 0) return;
  const jar = await cookies();
  jar.set(DRAFT_COOKIE, `${accessTokenId}.${randomBytes(32).toString("base64url")}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/r/${encodeURIComponent(rawToken)}`,
    maxAge,
  });
}

/** The draft secret for this link, or null when this browser holds none. */
export async function readDraftSecret(accessTokenId: string): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(DRAFT_COOKIE)?.value;
  if (!raw) return null;
  const at = raw.indexOf(".");
  if (at <= 0 || raw.slice(0, at) !== accessTokenId) return null;
  return raw.slice(at + 1) || null;
}

/** Returns the verified access token id, or null. */
export async function readLinkSession(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [accessTokenId, expiresStr, sig] = parts;
  const payload = `${accessTokenId}.${expiresStr}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expiresStr) < Date.now()) return null;
  return accessTokenId;
}

export async function clearLinkSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
