"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  async function destination(): Promise<string> {
    const next = params.get("next");
    if (next && next.startsWith("/")) return next;
    const session = await authClient.getSession();
    const accountType = (session.data?.user as { accountType?: string } | undefined)
      ?.accountType;
    return accountType === "org" ? "/dashboard" : "/overview";
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const form = new FormData(e.currentTarget);
      const { error } = await authClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
      });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(error, "We couldn’t sign you in. Please try again."),
        });
        return;
      }
      router.push(await destination());
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onMagicLink(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    const email = (document.getElementById("email") as HTMLInputElement)?.value;
    if (!email) {
      document.getElementById("email")?.focus();
      showToast({
        tone: "info",
        title: "Enter your email first",
        message: "We need your email address before we can send a sign-in link.",
      });
      return;
    }
    setBusy(true);
    try {
      const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/overview" });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(error, "We couldn’t send the sign-in link. Please try again."),
        });
      } else {
        showToast({
          tone: "success",
          title: "Check your email",
          message: "We sent you a single-use sign-in link.",
        });
      }
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onPasskey(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) {
        showToast({
          tone: "error",
          message: userFacingError(res.error, "We couldn’t use your passkey. Try again or use your password."),
        });
        return;
      }
      router.push(await destination());
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardContent className="space-y-4">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="mb-1.5 text-xs font-medium text-accent underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onMagicLink} disabled={busy}>
            Email me a link
          </Button>
          <Button variant="secondary" onClick={onPasskey} disabled={busy}>
            Use a passkey
          </Button>
        </div>
        <p className="text-sm text-stone-600">
          New here?{" "}
          <Link href="/sign-up" className="font-medium underline">
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Suspense>
        <SignInForm />
      </Suspense>
    </main>
  );
}
