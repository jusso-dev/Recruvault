"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";

function SignUpForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [type, setType] = useState<"org" | "seeker">(
    params.get("type") === "org" ? "org" : "seeker",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email: String(form.get("email")),
      password: String(form.get("password")),
      accountType: type,
    });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Sign up failed.");
      return;
    }
    router.push(type === "org" ? "/onboarding" : "/wallet");
  }

  return (
    <Card className="w-full max-w-md">
      <CardContent className="space-y-4">
        <h1 className="text-xl font-semibold">Create your account</h1>
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
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Creating account…" : "Create account"}
          </Button>
        </form>
        <p className="text-sm text-stone-600">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium underline">
            Sign in
          </Link>
        </p>
        {type === "seeker" && (
          <p className="text-xs text-stone-500">
            Job seeker accounts and the wallet are free. Your data is private by
            default — nothing leaves your wallet without your explicit consent.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Suspense>
        <SignUpForm />
      </Suspense>
    </main>
  );
}
