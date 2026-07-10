"use client";

import { useState } from "react";
import { MailCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { userFacingError } from "@/lib/user-facing-errors";
import { Button, ButtonLink, Card, CardContent } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { useToast } from "@/components/toast";

export function VerifyEmailPanel({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  async function resendVerification() {
    setBusy(true);
    try {
      const { error } = await authClient.sendVerificationEmail({
        email,
        callbackURL: "/dashboard",
      });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(
            error,
            "We couldn’t send another verification email. Please try again shortly.",
          ),
        });
        return;
      }
      showToast({
        tone: "success",
        title: "Verification email sent",
        message: `Open the new link we sent to ${email}.`,
      });
    } catch (error) {
      showToast({
        tone: "error",
        message: userFacingError(
          error,
          "We couldn’t send another verification email. Please try again shortly.",
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardContent className="space-y-5 p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-md border border-accent-tint-border bg-accent-tint text-accent">
          <MailCheck className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <p className="text-sm font-medium text-accent">Account verification</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950">
            Verify your email
          </h1>
          <p className="mt-3 text-sm leading-6 text-stone-600">
            Confirm <strong className="font-semibold text-stone-800">{email}</strong> before
            opening your organisation workspace. This protects invitations and actions made on
            behalf of your organisation.
          </p>
        </div>
        <div className="rounded-md border border-stone-200 bg-stone-100/70 p-4 text-sm leading-6 text-stone-600">
          Check your inbox and open the verification link. If it has expired, send a new one below.
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" onClick={resendVerification} disabled={busy}>
            {busy ? "Sending…" : "Resend verification email"}
          </Button>
          <ButtonLink href="/dashboard" variant="secondary">
            I’ve verified my email
          </ButtonLink>
        </div>
        <div className="border-t border-stone-200 pt-3">
          <SignOutButton />
        </div>
      </CardContent>
    </Card>
  );
}
