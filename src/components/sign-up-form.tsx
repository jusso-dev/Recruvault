"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MailCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";

export function SignUpForm({ allowRecruiterSignup }: { allowRecruiterSignup: boolean }) {
  const params = useSearchParams();
  const [type, setType] = useState<"org" | "seeker">(
    allowRecruiterSignup && params.get("type") === "org" ? "org" : "seeker",
  );
  const [busy, setBusy] = useState(false);
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);
  const { showToast } = useToast();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const form = new FormData(e.currentTarget);
      const email = String(form.get("email")).trim();
      const { error } = await authClient.signUp.email({
        name: String(form.get("name")),
        email,
        password: String(form.get("password")),
        accountType: type,
        callbackURL: type === "org" ? "/onboarding" : "/overview",
      });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(
            error,
            "We couldn’t create your account. Please check your details and try again.",
          ),
        });
        return;
      }
      setCreatedEmail(email);
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    if (!createdEmail) return;
    setBusy(true);
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: createdEmail,
        callbackURL: type === "org" ? "/onboarding" : "/overview",
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
        message: `We sent a new link to ${createdEmail}.`,
      });
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  if (createdEmail) {
    return (
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-accent-tint-border bg-accent-tint text-accent">
            <MailCheck className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-medium text-accent">Account created</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950">
              Check your email
            </h1>
            <p className="mt-3 text-sm leading-6 text-stone-600">
              We sent a verification link to{" "}
              <strong className="font-semibold text-stone-800">{createdEmail}</strong>. Open it
              to verify your address and sign in automatically.
            </p>
          </div>
          <div className="rounded-md border border-stone-200 bg-stone-100/70 p-4 text-sm leading-6 text-stone-600">
            The link expires in one hour. Check your spam folder if it does not arrive within a few
            minutes.
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" onClick={resendVerification} disabled={busy}>
              {busy ? "Sending…" : "Resend verification email"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreatedEmail(null)}
              disabled={busy}
            >
              Use another email
            </Button>
          </div>
          <p className="text-xs leading-5 text-stone-500">
            After verification, {type === "org" ? "you’ll continue to organisation setup" : "your job-seeker workspace will open"}.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardContent className="space-y-4">
        <h1 className="text-xl font-semibold">Create your account</h1>
        {allowRecruiterSignup ? (
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Account type">
            <Button
              type="button"
              variant={type === "seeker" ? "default" : "secondary"}
              onClick={() => setType("seeker")}
              aria-pressed={type === "seeker"}
            >
              Job seeker
            </Button>
            <Button
              type="button"
              variant={type === "org" ? "default" : "secondary"}
              onClick={() => setType("org")}
              aria-pressed={type === "org"}
            >
              Recruiter / organisation
            </Button>
          </div>
        ) : (
          <p className="rounded-md border border-stone-200 bg-stone-100/70 p-3 text-sm leading-5 text-stone-600">
            This registration form is for job seekers. The organisation owner account is created
            through the one-time setup page.
          </p>
        )}
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="name">Full name</Label>
            <Input id="name" name="name" required autoComplete="name" />
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Creating account…" : "Create account"}
          </Button>
        </form>
        <p className="text-sm text-stone-600">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-accent underline underline-offset-4">
            Sign in
          </Link>
        </p>
        {type === "seeker" && (
          <p className="text-xs leading-5 text-stone-500">
            Job seeker accounts are free. Your data is private by default and is shared only with
            your explicit consent.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
