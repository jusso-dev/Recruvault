import { randomBytes } from "crypto";
import { describe, expect, it } from "vitest";
import { readUnlockKey } from "@/lib/vault-enrollment";
import {
  assertStrongCustomerKey,
  SCRYPT_PARAMS,
  customerKeyVerifier,
  decryptDocumentBytes,
  derivePassphraseKey,
  encryptDocumentBytes,
  generateCustomerKey,
  generateKdfSalt,
  generateRecipientKeyPair,
  openCrkWrap,
  openSeal,
  parseCustomerKey,
  sealToPublicKey,
  verifierMatches,
  wrapWithCrk,
  VaultCryptoError,
  documentAad,
} from "@/lib/vault-crypto";

describe("customer keys", () => {
  it("round-trips a generated key and rejects a short value", () => {
    const encoded = generateCustomerKey();
    const key = parseCustomerKey(encoded);
    expect(key).toHaveLength(32);
    expect(() => parseCustomerKey("short")).toThrow(VaultCryptoError);
  });

  it("binds the verifier to the owner", () => {
    const key = parseCustomerKey(generateCustomerKey());
    const verifier = customerKeyVerifier(key, "organisation", "org-1");
    expect(verifierMatches(key, "organisation", "org-1", verifier)).toBe(true);
    expect(verifierMatches(key, "candidate", "org-1", verifier)).toBe(false);
    expect(verifierMatches(randomBytes(32), "organisation", "org-1", verifier)).toBe(false);
  });

  it("derives a passphrase with a salt and rejects a short passphrase", () => {
    const salt = Buffer.from(generateKdfSalt(), "base64url");
    const derived = derivePassphraseKey("correct horse battery", salt);
    expect(derived.equals(derivePassphraseKey("correct horse battery", salt))).toBe(true);
    expect(derived.equals(derivePassphraseKey("correct horse battery", randomBytes(16)))).toBe(false);
    expect(() => derivePassphraseKey("short", salt)).toThrow(VaultCryptoError);
  });
});

describe("owner envelopes", () => {
  const owner = { type: "organisation", id: "org-1" };
  const aad = documentAad(owner.type, owner.id, "doc-1", "bytes");

  it("rejects a swapped owner, a wrong key, and tampered ciphertext", () => {
    const crk = randomBytes(32);
    const dek = randomBytes(32);
    const wrapped = wrapWithCrk(crk, dek, aad);
    expect(openCrkWrap(crk, wrapped, aad).equals(dek)).toBe(true);
    expect(() => openCrkWrap(crk, wrapped, documentAad("candidate", owner.id, "doc-1", "bytes"))).toThrow();
    expect(() => openCrkWrap(randomBytes(32), wrapped, aad)).toThrow();
  });

  it("seals a data key to one recipient", () => {
    const alice = generateRecipientKeyPair();
    const bob = generateRecipientKeyPair();
    const dek = randomBytes(32);
    const sealed = sealToPublicKey(alice.publicKey, dek, aad);
    expect(openSeal(alice.privateKey, alice.publicKey, sealed, aad).equals(dek)).toBe(true);
    expect(() => openSeal(bob.privateKey, bob.publicKey, sealed, aad)).toThrow();
    expect(() => openSeal(alice.privateKey, alice.publicKey, sealed, "other")).toThrow();
  });

  it("stores document bytes that do not contain the plaintext marker", () => {
    const dek = randomBytes(32);
    const plaintext = Buffer.from("%PDF-1.7 career record");
    const ciphertext = encryptDocumentBytes(dek, plaintext, aad);
    expect(ciphertext.includes("%PDF-")).toBe(false);
    expect(decryptDocumentBytes(dek, ciphertext, aad).equals(plaintext)).toBe(true);
    expect(() => decryptDocumentBytes(randomBytes(32), ciphertext, aad)).toThrow();
  });
});

describe("imported key strength and KDF parameters", () => {
  it("rejects constant, repeating, and stepped keys but accepts random ones", () => {
    expect(() => assertStrongCustomerKey(Buffer.alloc(32))).toThrow(VaultCryptoError);
    expect(() => assertStrongCustomerKey(Buffer.from(Array.from({ length: 32 }, (_, i) => i)))).toThrow(VaultCryptoError);
    expect(() => assertStrongCustomerKey(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)))).toThrow(VaultCryptoError);
    expect(() => assertStrongCustomerKey(Buffer.from(Array.from({ length: 32 }, (_, i) => [1, 2, 3][i % 3])))).toThrow(VaultCryptoError);
    for (let n = 0; n < 200; n += 1) expect(() => assertStrongCustomerKey(randomBytes(32))).not.toThrow();
  });

  it("derives with the stored parameters and refuses out-of-range ones", () => {
    const salt = randomBytes(16);
    const v1 = { N: 16384, r: 8, p: 1, version: 1 };
    const legacy = derivePassphraseKey("correct horse battery", salt, v1);
    expect(derivePassphraseKey("correct horse battery", salt, null).equals(legacy)).toBe(true);
    expect(derivePassphraseKey("correct horse battery", salt, SCRYPT_PARAMS).equals(legacy)).toBe(false);
    expect(() => derivePassphraseKey("correct horse battery", salt, { ...v1, N: 1024 })).toThrow(VaultCryptoError);
    expect(() => derivePassphraseKey("correct horse battery", salt, { ...v1, N: 2 ** 22 })).toThrow(VaultCryptoError);
    expect(() => derivePassphraseKey("correct horse battery", salt, { ...v1, N: 20000 })).toThrow(VaultCryptoError);
  });

  it("reads the rotation form's current key fields only", () => {
    const data = new FormData();
    data.set("encryptionKey", generateCustomerKey());
    expect(readUnlockKey(data, { kdf: null, kdfSalt: null }, "current").ok).toBe(false);
    const current = generateCustomerKey();
    data.set("currentEncryptionKey", current);
    const read = readUnlockKey(data, { kdf: null, kdfSalt: null }, "current");
    expect(read.ok && read.crk.equals(parseCustomerKey(current))).toBe(true);
  });
});
