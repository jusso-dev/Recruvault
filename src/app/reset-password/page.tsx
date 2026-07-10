"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { KeyRound } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { userFacingError } from "@/lib/user-facing-errors";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";

function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token");
  const invalid = params.get("error") === "INVALID_TOKEN" || !token;
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const { showToast } = useToast();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirmPassword"))) {
      showToast({ tone: "error", message: "The passwords do not match. Please try again." });
      return;
    }
    setBusy(true);
    try {
      const { error } = await authClient.resetPassword({ newPassword: password, token: token! });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(
            error,
            "We couldn’t reset your password. Request a new link and try again.",
          ),
        });
        return;
      }
      setComplete(true);
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardContent className="space-y-5 p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-md border border-accent-tint-border bg-accent-tint text-accent">
          <KeyRound className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-stone-950">
            {invalid ? "Reset link expired" : complete ? "Password updated" : "Choose a new password"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            {invalid
              ? "This password reset link is invalid or has expired. Request a new link to continue."
              : complete
                ? "Your password has been changed. You can now sign in with your new password."
                : "Use at least eight characters. Choose a password you do not use for another service."}
          </p>
        </div>
        {!invalid && !complete && (
          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                minLength={8}
                required
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="confirmPassword">Confirm new password</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                minLength={8}
                required
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
        <Link
          href={invalid ? "/forgot-password" : "/sign-in"}
          className="inline-flex text-sm font-medium text-accent underline underline-offset-4"
        >
          {invalid ? "Request a new link" : "Back to sign in"}
        </Link>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Suspense>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
