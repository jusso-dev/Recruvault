import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { verifySvixSignature } from "@/lib/svix";

const RAW_KEY = Buffer.from("super-secret-webhook-key-material");
const SECRET = `whsec_${RAW_KEY.toString("base64")}`;
const ID = "msg_123";
const TS = "1720483200"; // fixed epoch seconds
const NOW = Number(TS) * 1000;
const PAYLOAD = JSON.stringify({ type: "email.bounced", data: { to: "x@example.com" } });

function sign(payload: string, ts = TS, id = ID) {
  const sig = createHmac("sha256", RAW_KEY).update(`${id}.${ts}.${payload}`).digest("base64");
  return `v1,${sig}`;
}

const headers = (over: Partial<{ id: string | null; timestamp: string | null; signature: string | null }> = {}) => ({
  id: ID,
  timestamp: TS,
  signature: sign(PAYLOAD),
  ...over,
});

describe("verifySvixSignature", () => {
  it("accepts a correctly signed payload", () => {
    expect(verifySvixSignature(SECRET, headers(), PAYLOAD, NOW)).toBe(true);
  });

  it("accepts when one of several space-separated signatures matches", () => {
    const sig = `v1,deadbeef ${sign(PAYLOAD)}`;
    expect(verifySvixSignature(SECRET, headers({ signature: sig }), PAYLOAD, NOW)).toBe(true);
  });

  it("fails closed with no secret configured", () => {
    expect(verifySvixSignature(undefined, headers(), PAYLOAD, NOW)).toBe(false);
  });

  it("rejects a wrong signature", () => {
    expect(
      verifySvixSignature(SECRET, headers({ signature: "v1,not-the-real-sig" }), PAYLOAD, NOW),
    ).toBe(false);
  });

  it("rejects a tampered payload", () => {
    expect(verifySvixSignature(SECRET, headers(), PAYLOAD + "x", NOW)).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verifySvixSignature(SECRET, headers({ id: null }), PAYLOAD, NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, headers({ timestamp: null }), PAYLOAD, NOW)).toBe(false);
    expect(verifySvixSignature(SECRET, headers({ signature: null }), PAYLOAD, NOW)).toBe(false);
  });

  it("rejects a stale timestamp (> 5 min skew)", () => {
    const stale = NOW + 6 * 60 * 1000;
    expect(verifySvixSignature(SECRET, headers(), PAYLOAD, stale)).toBe(false);
  });
});
