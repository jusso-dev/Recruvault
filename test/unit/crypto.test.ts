import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqualHex,
  decryptFieldWithKey,
  encryptFieldWithKey,
  generateOpaqueToken,
  generateOtp,
  sha256,
} from "@/lib/crypto";

describe("AES-256-GCM field encryption", () => {
  const key = randomBytes(32);

  it("round-trips a value under the same key", async () => {
    const ct = await encryptFieldWithKey("candidate@example.com", key);
    expect(decryptFieldWithKey(ct, key)).toBe("candidate@example.com");
  });

  it("produces a fresh IV per call (no deterministic ciphertext)", async () => {
    const a = await encryptFieldWithKey("same", key);
    const b = await encryptFieldWithKey("same", key);
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext (GCM auth tag)", async () => {
    const ct = await encryptFieldWithKey("secret", key);
    const [iv, tag, body] = ct.split(".");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 0xff;
    const tampered = `${iv}.${tag}.${flipped.toString("base64")}`;
    expect(() => decryptFieldWithKey(tampered, key)).toThrow();
  });

  it("rejects decryption under the wrong key", async () => {
    const ct = await encryptFieldWithKey("secret", key);
    expect(() => decryptFieldWithKey(ct, randomBytes(32))).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptFieldWithKey("not-a-ciphertext", key)).toThrow("Malformed ciphertext.");
  });
});

describe("token + hash helpers", () => {
  it("sha256 matches the known empty-string vector", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("opaque token stores only its hash", () => {
    const { token, tokenHash } = generateOpaqueToken();
    expect(tokenHash).toBe(sha256(token));
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
  });

  it("OTP is six digits and hashed", () => {
    const { code, codeHash } = generateOtp();
    expect(code).toMatch(/^\d{6}$/);
    expect(codeHash).toBe(sha256(code));
  });
});

describe("constantTimeEqualHex", () => {
  it("returns true for equal hex", () => {
    expect(constantTimeEqualHex("abcd", "abcd")).toBe(true);
  });
  it("returns false for different hex", () => {
    expect(constantTimeEqualHex("abcd", "abce")).toBe(false);
  });
  it("returns false for length mismatch", () => {
    expect(constantTimeEqualHex("ab", "abcd")).toBe(false);
  });
});
