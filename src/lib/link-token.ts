import "server-only";
import { createHmac } from "crypto";
import { sha256 } from "@/lib/crypto";

/**
 * Secure request-link tokens for queued deliveries. The token is an HMAC of
 * the access-token id under the server's link secret, so the row (with only
 * the token hash) can be committed together with its outbox event, and the
 * delivery worker can rebuild the same link on every retry without the raw
 * token ever being stored, logged, or carried in an event or step output.
 * Expiry reminders still rotate to a random token.
 */

function secret(): string {
  const s = process.env.LINK_SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error("LINK_SESSION_SECRET or BETTER_AUTH_SECRET is required.");
  return s;
}

export function deliveryLinkToken(accessTokenId: string): { token: string; tokenHash: string } {
  const token = createHmac("sha256", secret()).update(`request-link:v1:${accessTokenId}`).digest("base64url");
  return { token, tokenHash: sha256(token) };
}
