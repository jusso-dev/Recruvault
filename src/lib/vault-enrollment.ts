import {
  derivePassphraseKey,
  parseCustomerKey,
  SCRYPT_PARAMS,
  VaultCryptoError,
} from "@/lib/vault-crypto";

export interface EnrolledKeyMaterial {
  crk: Buffer;
  kdf: "scrypt" | null;
  kdfSalt: string | null;
  kdfParams: { N: number; r: number; p: number; version: number } | null;
}

export type KeyRead = { ok: true; material: EnrolledKeyMaterial } | { ok: false; error: string };

function acknowledged(formData: FormData): boolean {
  return formData.get("keyBackupAck") === "yes";
}

/** Read a generated, imported, or passphrase-derived key from a form body. */
export function readEnrollmentKey(formData: FormData): KeyRead {
  if (!acknowledged(formData)) {
    return {
      ok: false,
      error: "Confirm that you have saved the encryption key. It cannot be reset with your password.",
    };
  }
  const mode = String(formData.get("keyMode") ?? "generated");
  try {
    if (mode === "passphrase") {
      const passphrase = String(formData.get("passphrase") ?? "");
      const confirm = String(formData.get("passphraseConfirm") ?? "");
      const salt = String(formData.get("kdfSalt") ?? "");
      if (passphrase !== confirm) return { ok: false, error: "The passphrases do not match." };
      const saltBytes = Buffer.from(salt, "base64url");
      const crk = derivePassphraseKey(passphrase, saltBytes);
      return {
        ok: true,
        material: {
          crk,
          kdf: "scrypt",
          kdfSalt: salt,
          kdfParams: { ...SCRYPT_PARAMS, version: 1 },
        },
      };
    }
    const key = String(formData.get("encryptionKey") ?? "");
    const confirm = String(formData.get("encryptionKeyConfirm") ?? "");
    if (!key || key !== confirm) return { ok: false, error: "Enter the encryption key twice, exactly." };
    return {
      ok: true,
      material: { crk: parseCustomerKey(key), kdf: null, kdfSalt: null, kdfParams: null },
    };
  } catch (error) {
    if (error instanceof VaultCryptoError) return { ok: false, error: error.message };
    return { ok: false, error: "The encryption key could not be read." };
  }
}

export function readUnlockKey(
  formData: FormData,
  vault: { kdf: string | null; kdfSalt: string | null },
): { ok: true; crk: Buffer } | { ok: false; error: string } {
  try {
    if (vault.kdf === "scrypt") {
      if (!vault.kdfSalt) return { ok: false, error: "This vault is missing its passphrase salt." };
      const passphrase = String(formData.get("currentPassphrase") ?? formData.get("passphrase") ?? "");
      return {
        ok: true,
        crk: derivePassphraseKey(passphrase, Buffer.from(vault.kdfSalt, "base64url")),
      };
    }
    return {
      ok: true,
      crk: parseCustomerKey(String(formData.get("currentEncryptionKey") ?? formData.get("encryptionKey") ?? "")),
    };
  } catch (error) {
    if (error instanceof VaultCryptoError) return { ok: false, error: "That encryption key does not match." };
    return { ok: false, error: "That encryption key does not match." };
  }
}
