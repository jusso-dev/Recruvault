"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { completePlatformSetup } from "@/actions/setup";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";
import { BrandMark } from "@/components/brand-mark";
import { VaultKeyFields } from "@/components/vault-key-fields";
import { SignOutButton } from "@/components/sign-out";

/**
 * First-owner setup in three resumable steps: create (or sign in to) the
 * owner account, verify its email through the emailed link, then present the
 * operator's bootstrap token with the organisation and its encryption key.
 * Each step survives a refresh or browser restart because the state lives in
 * the BetterAuth session, not in this component.
 */
export function SetupForm({
  signedIn = false,
  emailVerified = false,
  email,
}: {
  signedIn?: boolean;
  emailVerified?: boolean;
  email?: string;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"create" | "sign-in">("create");
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const address = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    if (mode === "create" && password !== String(data.get("confirmPassword") ?? "")) {
      showToast({ tone: "error", message: "The passwords do not match. Enter them again." });
      form.querySelector<HTMLInputElement>("#confirmPassword")?.focus();
      return;
    }
    setBusy(true);
    try {
      const { error } =
        mode === "create"
          ? await authClient.signUp.email({
              name: `${String(data.get("firstName") ?? "").trim()} ${String(data.get("lastName") ?? "").trim()}`.trim(),
              email: address,
              password,
              callbackURL: "/setup",
            })
          : await authClient.signIn.email({ email: address, password, callbackURL: "/setup" });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(error, "We couldn’t open the owner account. Check your details and try again."),
        });
        return;
      }
      if (mode === "create") setSentTo(address);
      router.refresh();
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!email) return;
    setBusy(true);
    try {
      const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/setup" });
      if (error) {
        showToast({ tone: "error", message: userFacingError(error, "We couldn’t send the email. Try again shortly.") });
        return;
      }
      setSentTo(email);
    } finally {
      setBusy(false);
    }
  }

  async function onSetup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await completePlatformSetup(new FormData(event.currentTarget));
      if (!result.ok) {
        showToast({ tone: "error", message: userFacingError(result.error) });
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      showToast({ tone: "error", message: userFacingError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-2xl overflow-hidden">
      <div className="border-b border-stone-200 bg-stone-100/65 px-6 py-5">
        <div className="flex items-center gap-3">
          <BrandMark size={40} />
          <div>
            <p className="font-semibold tracking-tight text-stone-950">Recruvault</p>
            <p className="text-xs text-stone-500">One-time workspace setup</p>
          </div>
        </div>
      </div>
      <CardContent className="space-y-6 p-6 sm:p-8">
        <div>
          <p className="text-sm font-medium text-accent">
            First owner · step {!signedIn ? 1 : !emailVerified ? 2 : 3} of 3
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950">
            Set up your recruiter workspace
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">
            Create the owner account, verify its email address, then create the organisation
            with the bootstrap token your operator provisioned.
          </p>
        </div>

        {!signedIn && (
          <form onSubmit={onAccount} className="space-y-5">
            {mode === "create" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName">First name</Label>
                  <Input id="firstName" name="firstName" required autoComplete="given-name" />
                </div>
                <div>
                  <Label htmlFor="lastName">Last name</Label>
                  <Input id="lastName" name="lastName" required autoComplete="family-name" />
                </div>
              </div>
            )}
            <div>
              <Label htmlFor="email">Work email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete={mode === "create" ? "new-password" : "current-password"}
                />
              </div>
              {mode === "create" && (
                <div>
                  <Label htmlFor="confirmPassword">Confirm password</Label>
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>
              )}
            </div>
            {sentTo && (
              <p className="text-sm text-stone-600">We sent a verification link to {sentTo}.</p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Working…" : mode === "create" ? "Create owner account" : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setMode(mode === "create" ? "sign-in" : "create")}
            >
              {mode === "create" ? "Already created the owner account? Sign in" : "Create a new owner account"}
            </Button>
          </form>
        )}

        {signedIn && !emailVerified && (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-stone-600">
              Open the verification link sent to {email}. It brings you back here. Setup cannot
              finish until the address is verified.
            </p>
            {sentTo && <p className="text-sm text-stone-600">A new link is on its way.</p>}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" onClick={resend} disabled={busy}>
                {busy ? "Sending…" : "Resend verification email"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => router.refresh()}>
                I’ve verified my email
              </Button>
            </div>
            <SignOutButton />
          </div>
        )}

        {signedIn && emailVerified && (
          <form onSubmit={onSetup} className="space-y-5">
            <p className="text-sm text-stone-600">Signed in as {email}.</p>
            <div>
              <Label htmlFor="organisationName">Organisation name</Label>
              <div className="relative">
                <Building2 className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-stone-400" aria-hidden />
                <Input
                  id="organisationName"
                  name="organisationName"
                  required
                  className="pl-9"
                  placeholder="Acacia Talent Partners"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="bootstrapToken">Bootstrap token</Label>
              <Input id="bootstrapToken" name="bootstrapToken" type="password" required autoComplete="off" />
            </div>
            <VaultKeyFields />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Setting up workspace…" : "Create organisation"}
            </Button>
          </form>
        )}
        <p className="text-xs leading-5 text-stone-500">
          Setup closes permanently once the first owner is created. Future users sign in or
          create an invited account through the standard account flow.
        </p>
      </CardContent>
    </Card>
  );
}
