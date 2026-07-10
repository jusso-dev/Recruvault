"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { requestOtp, verifyOtp } from "@/actions/link";
import { Button, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";

export function OtpVerify({ token }: { token: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"start" | "code">("start");
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  async function sendCode() {
    setBusy(true);
    try {
      const res = await requestOtp(token);
      if (!res.ok) {
        showToast({
          tone: "error",
          message: userFacingError(res.error, "We couldn’t send the code. Please try again."),
        });
        return;
      }
      setStage("code");
      showToast({
        tone: "success",
        title: "Code sent",
        message: "Check your email for a six-digit verification code.",
      });
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const code = String(new FormData(e.currentTarget).get("code") ?? "");
      const res = await verifyOtp(token, code);
      if (!res.ok) {
        showToast({
          tone: "error",
          message: userFacingError(res.error, "That code didn’t work. Check it and try again."),
        });
        return;
      }
      router.push(`/r/${token}/respond`);
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  if (stage === "start") {
    return (
      <div className="space-y-2">
        <Button onClick={sendCode} disabled={busy} className="w-full">
          {busy ? "Sending…" : "Send me the code"}
        </Button>
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
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Verifying…" : "Verify and continue"}
      </Button>
      <button
        type="button"
        onClick={sendCode}
        className="w-full text-center text-sm text-stone-500 underline"
        disabled={busy}
      >
        Send a new code
      </button>
    </form>
  );
}
