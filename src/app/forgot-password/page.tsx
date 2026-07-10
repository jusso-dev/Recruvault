"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { userFacingError } from "@/lib/user-facing-errors";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const { showToast } = useToast();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const form = new FormData(e.currentTarget);
      const { error } = await authClient.requestPasswordReset({
        email: String(form.get("email")),
        redirectTo: "/reset-password",
      });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(
            error,
            "We couldn’t send the reset email. Please try again shortly.",
          ),
        });
        return;
      }
      setSent(true);
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-accent-tint-border bg-accent-tint text-accent">
            <Mail className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-stone-950">
              {sent ? "Check your email" : "Forgot your password?"}
            </h1>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              {sent
                ? "If an account matches that address, we sent a password reset link. It expires in one hour."
                : "Enter your account email and we’ll send you a secure password reset link."}
            </p>
          </div>
          {!sent && (
            <form onSubmit={onSubmit} className="space-y-3">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required autoComplete="email" />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}
          <Link
            href="/sign-in"
            className="inline-flex text-sm font-medium text-accent underline underline-offset-4"
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
