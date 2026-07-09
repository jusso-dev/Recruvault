"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { requestOtp, verifyOtp } from "@/actions/link";
import { Button, Input, Label } from "@/components/ui";

export function OtpVerify({ token }: { token: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"start" | "code">("start");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    setBusy(true);
    setError(null);
    const res = await requestOtp(token);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Could not send the code.");
      return;
    }
    setStage("code");
  }

  async function onVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    const res = await verifyOtp(token, code);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Verification failed.");
      return;
    }
    router.push(`/r/${token}/respond`);
  }

  if (stage === "start") {
    return (
      <div className="space-y-2">
        <Button onClick={sendCode} disabled={busy} className="w-full">
          {busy ? "Sending…" : "Send me the code"}
        </Button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={onVerify} className="space-y-3">
      <div>
        <Label htmlFor="code">Enter the 6-digit code</Label>
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          className="text-center text-lg tracking-[0.5em]"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Verifying…" : "Verify and continue"}
      </Button>
      <button
        type="button"
        onClick={sendCode}
        className="w-full text-center text-sm text-zinc-500 underline"
        disabled={busy}
      >
        Send a new code
      </button>
    </form>
  );
}
