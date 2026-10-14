import {
  assertStrongCustomerKey,
  derivePassphraseKey,
  generateKdfSalt,
  parseCustomerKey,
  SCRYPT_PARAMS,
  VaultCryptoError,
  type KdfParams,
} from "@/lib/vault-crypto";

export interface EnrolledKeyMaterial {
  crk: Buffer;
  kdf: "scrypt" | null;
  kdfSalt: string | null;
  kdfParams: KdfParams | null;
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
      if (passphrase !== confirm) return { ok: false, error: "The passphrases do not match." };
      // The salt is chosen here, never by the client, so it is unique per vault.
      const salt = generateKdfSalt();
      const crk = derivePassphraseKey(passphrase, Buffer.from(salt, "base64url"), SCRYPT_PARAMS);
      return {
        ok: true,
        material: { crk, kdf: "scrypt", kdfSalt: salt, kdfParams: { ...SCRYPT_PARAMS } },
      };
    }
    const key = String(formData.get("encryptionKey") ?? "");
    const confirm = String(formData.get("encryptionKeyConfirm") ?? "");
    if (!key || key !== confirm) return { ok: false, error: "Enter the encryption key twice, exactly." };
    const crk = parseCustomerKey(key);
    assertStrongCustomerKey(crk);
    return { ok: true, material: { crk, kdf: null, kdfSalt: null, kdfParams: null } };
  } catch (error) {
    if (error instanceof VaultCryptoError) return { ok: false, error: error.message };
    return { ok: false, error: "The encryption key could not be read." };
  }
}

/**
 * Read the key that opens an existing vault. `current` reads only the
 * current* fields so a rotation form cannot mistake the new key for the old.
 */
export function readUnlockKey(
  formData: FormData,
  vault: { kdf: string | null; kdfSalt: string | null; kdfParams?: KdfParams | null },
  fields: "unlock" | "current" = "unlock",
): { ok: true; crk: Buffer } | { ok: false; error: string } {
  const field = (current: string, unlock: string) => {
    const value = formData.get(current) ?? (fields === "unlock" ? formData.get(unlock) : null);
    return typeof value === "string" ? value : "";
  };
  try {
    if (vault.kdf === "scrypt") {
      if (!vault.kdfSalt) return { ok: false, error: "This vault is missing its passphrase salt." };
      return {
        ok: true,
        crk: derivePassphraseKey(
          field("currentPassphrase", "passphrase"),
          Buffer.from(vault.kdfSalt, "base64url"),
          vault.kdfParams ?? null,
        ),
      };
    }
    return { ok: true, crk: parseCustomerKey(field("currentEncryptionKey", "encryptionKey")) };
  } catch {
    return { ok: false, error: "That encryption key does not match." };
  }
}
