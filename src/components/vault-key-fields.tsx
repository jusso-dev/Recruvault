"use client";

import { useState } from "react";
import { Button, Input, Label } from "@/components/ui";

export function VaultKeyFields() {
  const [mode, setMode] = useState<"generated" | "import" | "passphrase">("generated");
  const [key, setKey] = useState("");

  function generate() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    setKey(encoded);
    setMode("generated");
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-stone-800">Encryption key</legend>
      <p className="text-sm leading-6 text-stone-600">
        This is the only key that can open this workspace&apos;s career records. Treat it
        like a master key: anyone who has it can read those records, and Recruvault cannot
        issue a replacement. A password reset, a new sign-in, and support cannot recover it.
        If it is lost, the profiles, documents, and submissions it protects stay ciphertext
        forever. Keep a copy somewhere you control, not in email, chat, or the same place as
        a database backup.
      </p>
      <input type="hidden" name="keyMode" value={mode} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={generate}>
          Generate encryption key
        </Button>
        <Button type="button" variant="ghost" onClick={() => setMode("import")}>
          Import a key
        </Button>
        <Button type="button" variant="ghost" onClick={() => setMode("passphrase")}>
          Use a passphrase
        </Button>
      </div>
      {mode === "passphrase" ? (
        <>
          <div>
            <Label htmlFor="passphrase">Passphrase</Label>
            <Input id="passphrase" name="passphrase" type="password" required minLength={12} autoComplete="new-password" />
          </div>
          <div>
            <Label htmlFor="passphraseConfirm">Confirm passphrase</Label>
            <Input id="passphraseConfirm" name="passphraseConfirm" type="password" required minLength={12} autoComplete="new-password" />
          </div>
        </>
      ) : (
        <>
          <div>
            <Label htmlFor="encryptionKey">Encryption key</Label>
            <Input
              id="encryptionKey"
              name="encryptionKey"
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setMode(event.target.value ? "import" : "generated");
              }}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <Label htmlFor="encryptionKeyConfirm">Confirm encryption key</Label>
            <Input id="encryptionKeyConfirm" name="encryptionKeyConfirm" type="password" required autoComplete="off" />
          </div>
        </>
      )}
      <label className="flex items-start gap-2 text-sm leading-5 text-stone-700">
        <input className="mt-1" type="checkbox" name="keyBackupAck" value="yes" required />
        <span>I have saved this encryption key somewhere I control, outside Recruvault. I understand that losing it permanently removes access to the career records it protects.</span>
      </label>
    </fieldset>
  );
}
