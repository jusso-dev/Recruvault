import { createHmac, timingSafeEqual } from "crypto";

/**
 * Svix webhook signature verification (used by the Resend webhook receiver).
 * Pure and header-agnostic so it can be unit-tested without a request object.
 */

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function verifySvixSignature(
  secret: string | undefined,
  headers: SvixHeaders,
  payload: string,
  nowMs: number = Date.now(),
): boolean {
  // Fail closed: without a configured secret we cannot verify the signature,
  // so reject rather than trust unsigned payloads (they mutate suppression).
  if (!secret) return false;

  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  // Reject stale timestamps (5 minute tolerance).
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  return signature.split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
