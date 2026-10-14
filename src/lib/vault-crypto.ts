import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  type KeyObject,
} from "crypto";

/**
 * Customer-root cryptography. Pure functions only — no database and no logging.
 *
 * This is envelope encryption under a key the customer holds. It is not
 * zero-knowledge: while a session or API key is unlocked, the server can
 * unwrap that key to render and process data. A database copy alone cannot.
 */

export const CRK_BYTES = 32;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
  version: number;
}

// Version 2 is used for new passphrase enrolments. Version 1 (N=2^14) is
// accepted only when an existing vault row stores it.
export const SCRYPT_PARAMS: KdfParams = { N: 131072, r: 8, p: 1, version: 2 };
const SCRYPT_V1: KdfParams = { N: 16384, r: 8, p: 1, version: 1 };

export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultCryptoError";
  }
}

export function generateCustomerKey(): string {
  return randomBytes(CRK_BYTES).toString("base64url");
}

export function parseCustomerKey(value: string): Buffer {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{43,44}$/.test(trimmed)) {
    throw new VaultCryptoError("Encryption key must be a 256-bit key.");
  }
  const buf = Buffer.from(trimmed, "base64url");
  if (buf.length !== CRK_BYTES) throw new VaultCryptoError("Encryption key must be a 256-bit key.");
  return buf;
}

/**
 * Reject imported keys that are obviously not random: few distinct bytes, a
 * short repeating pattern, or a constant step (00 01 02 …). A uniformly random
 * 256-bit key fails these checks with negligible probability.
 */
export function assertStrongCustomerKey(key: Buffer): void {
  const weak = new VaultCryptoError("That key is not random enough. Generate a new key instead.");
  if (new Set(key).size < 16) throw weak;
  for (let period = 1; period <= key.length / 2; period += 1) {
    if (key.every((byte, i) => i < period || byte === key[i - period])) throw weak;
  }
  const step = (key[1] - key[0] + 256) % 256;
  if (key.every((byte, i) => i === 0 || (byte - key[i - 1] + 256) % 256 === step)) throw weak;
}

export function customerKeyVerifier(crk: Buffer, ownerType: string, ownerId: string): string {
  return createHmac("sha256", crk)
    .update(`recruvault.verifier.v1|${ownerType}|${ownerId}`)
    .digest("hex");
}

export function verifierMatches(
  crk: Buffer,
  ownerType: string,
  ownerId: string,
  verifier: string,
): boolean {
  const actual = Buffer.from(customerKeyVerifier(crk, ownerType, ownerId), "hex");
  const expected = Buffer.from(verifier, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Bounds stop a tampered kdf_params row from forcing a weak or abusive derivation. */
function scryptOptions(params: KdfParams | null | undefined) {
  const chosen = params ?? SCRYPT_V1;
  const { N, r, p } = chosen;
  const powerOfTwo = Number.isInteger(N) && N > 0 && (N & (N - 1)) === 0;
  if (!powerOfTwo || N < SCRYPT_V1.N || N > 2 ** 20 || r < 8 || r > 16 || p < 1 || p > 4) {
    throw new VaultCryptoError("Passphrase parameters are invalid.");
  }
  return { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
}

export function derivePassphraseKey(
  passphrase: string,
  salt: Buffer,
  params: KdfParams | null = SCRYPT_PARAMS,
): Buffer {
  if (passphrase.length < 12) {
    throw new VaultCryptoError("Passphrase must be at least 12 characters.");
  }
  if (salt.length < 16) throw new VaultCryptoError("Passphrase salt is invalid.");
  return scryptSync(passphrase, salt, CRK_BYTES, scryptOptions(params));
}

export function generateKdfSalt(): string {
  return randomBytes(16).toString("base64url");
}

export interface RecipientKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateRecipientKeyPair(): RecipientKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }) as { x?: string };
  const priv = privateKey.export({ format: "jwk" }) as { d?: string };
  if (!pub.x || !priv.d) throw new VaultCryptoError("Could not generate a recipient key.");
  return { publicKey: pub.x, privateKey: priv.d };
}

function importPublic(raw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" });
}

function importPrivate(raw: string, publicKey: string): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: publicKey, d: raw },
    format: "jwk",
  });
}

function pack(iv: Buffer, tag: Buffer, ct: Buffer): string {
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

function unpack(payload: string): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const [iv, tag, ct] = payload.split(".");
  if (!iv || !tag || !ct) throw new VaultCryptoError("Malformed ciphertext.");
  return {
    iv: Buffer.from(iv, "base64url"),
    tag: Buffer.from(tag, "base64url"),
    ct: Buffer.from(ct, "base64url"),
  };
}

export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: string): string {
  if (key.length !== 32) throw new VaultCryptoError("Wrapping key must be 256 bits.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return pack(iv, cipher.getAuthTag(), ct);
}

export function aesGcmDecrypt(key: Buffer, payload: string, aad: string): Buffer {
  if (key.length !== 32) throw new VaultCryptoError("Wrapping key must be 256 bits.");
  const { iv, tag, ct } = unpack(payload);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function fieldAad(ownerType: string, ownerId: string, dekId: string, purpose: string, version: number) {
  return `field|${ownerType}|${ownerId}|${dekId}|${purpose}|v${version}`;
}

export function documentAad(
  ownerType: string,
  ownerId: string,
  documentId: string,
  purpose: string,
  version = 1,
) {
  return `document|${ownerType}|${ownerId}|${documentId}|${purpose}|v${version}`;
}

export function privateKeyAad(ownerType: string, ownerId: string, version: number) {
  return `vault-private|${ownerType}|${ownerId}|v${version}`;
}

export function wrapWithCrk(crk: Buffer, dek: Buffer, aad: string): string {
  return `crk.v1.${aesGcmEncrypt(crk, dek, aad)}`;
}

export function openCrkWrap(crk: Buffer, wrapped: string, aad: string): Buffer {
  if (!wrapped.startsWith("crk.v1.")) throw new VaultCryptoError("Malformed ciphertext.");
  return aesGcmDecrypt(crk, wrapped.slice("crk.v1.".length), aad);
}

export function sealToPublicKey(recipientPublic: string, plaintext: Buffer, aad: string): string {
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importPublic(recipientPublic),
  });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("recruvault.seal.v1"), 32),
  );
  const eph = ephemeral.publicKey.export({ format: "jwk" }) as { x?: string };
  if (!eph.x) throw new VaultCryptoError("Could not seal the data key.");
  return `seal.v1.${eph.x}.${aesGcmEncrypt(key, plaintext, aad)}`;
}

export function openSeal(
  recipientPrivate: string,
  recipientPublic: string,
  sealed: string,
  aad: string,
): Buffer {
  const prefix = "seal.v1.";
  if (!sealed.startsWith(prefix)) throw new VaultCryptoError("Malformed ciphertext.");
  const rest = sealed.slice(prefix.length);
  const splitAt = rest.indexOf(".");
  if (splitAt < 1) throw new VaultCryptoError("Malformed ciphertext.");
  const ephRaw = rest.slice(0, splitAt);
  const body = rest.slice(splitAt + 1);
  const shared = diffieHellman({
    privateKey: importPrivate(recipientPrivate, recipientPublic),
    publicKey: importPublic(ephRaw),
  });
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("recruvault.seal.v1"), 32),
  );
  return aesGcmDecrypt(key, body, aad);
}

export function wrapWithLinkSecret(linkSecret: string, dek: Buffer, aad: string): string {
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(linkSecret), Buffer.alloc(0), Buffer.from("recruvault.link-wrap.v1"), 32),
  );
  return `link.v1.${aesGcmEncrypt(key, dek, aad)}`;
}

export function openLinkWrap(linkSecret: string, wrapped: string, aad: string): Buffer {
  if (!wrapped.startsWith("link.v1.")) throw new VaultCryptoError("Malformed ciphertext.");
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(linkSecret), Buffer.alloc(0), Buffer.from("recruvault.link-wrap.v1"), 32),
  );
  return aesGcmDecrypt(key, wrapped.slice("link.v1.".length), aad);
}

export function wrapForCredential(secret: string, crk: Buffer): string {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret),
      Buffer.alloc(0),
      Buffer.from("recruvault.api-key-wrap.v1"),
      32,
    ),
  );
  return aesGcmEncrypt(key, crk, "api-key-delegation");
}

export function openCredentialWrap(secret: string, wrapped: string): Buffer {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret),
      Buffer.alloc(0),
      Buffer.from("recruvault.api-key-wrap.v1"),
      32,
    ),
  );
  return aesGcmDecrypt(key, wrapped, "api-key-delegation");
}

export function wrapUnlockCookie(cookieSecret: string, crk: Buffer): string {
  const key = Buffer.from(cookieSecret, "base64url");
  if (key.length !== 32) throw new VaultCryptoError("Unlock cookie is invalid.");
  return aesGcmEncrypt(key, crk, "vault-unlock");
}

export function openUnlockCookie(cookieSecret: string, wrapped: string): Buffer {
  const key = Buffer.from(cookieSecret, "base64url");
  if (key.length !== 32) throw new VaultCryptoError("Unlock cookie is invalid.");
  return aesGcmDecrypt(key, wrapped, "vault-unlock");
}

export function newUnlockCookieSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function encryptDocumentBytes(dek: Buffer, plaintext: Buffer, aad: string): Buffer {
  const packed = aesGcmEncrypt(dek, plaintext, aad);
  return Buffer.from(packed, "utf8");
}

export function decryptDocumentBytes(dek: Buffer, ciphertext: Buffer, aad: string): Buffer {
  return aesGcmDecrypt(dek, ciphertext.toString("utf8"), aad);
}
