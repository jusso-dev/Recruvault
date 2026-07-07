"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function destination(): Promise<string> {
    const next = params.get("next");
    if (next && next.startsWith("/")) return next;
    const session = await authClient.getSession();
    const accountType = (session.data?.user as { accountType?: string } | undefined)
      ?.accountType;
    return accountType === "org" ? "/dashboard" : "/wallet";
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Sign in failed.");
      return;
    }
    router.push(await destination());
  }

  async function onMagicLink(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    const email = (document.getElementById("email") as HTMLInputElement)?.value;
    if (!email) {
      setError("Enter your email first, then choose the sign-in link.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.magicLink({ email, callbackURL: "/wallet" });
    setBusy(false);
    if (error) setError(error.message ?? "Could not send the link.");
    else setInfo("Check your email for a single-use sign-in link.");
  }

  async function onPasskey(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.passkey();
    setBusy(false);
    if (res?.error) {
      setError(res.error.message ?? "Passkey sign-in failed.");
      return;
    }
    router.push(await destination());
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
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {info && <p className="text-sm text-emerald-700">{info}</p>}
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
        <p className="text-sm text-zinc-600">
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
