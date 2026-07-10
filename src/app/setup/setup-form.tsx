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

export function SetupForm() {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    if (password !== confirmPassword) {
      showToast({ tone: "error", message: "The passwords do not match. Enter them again." });
      form.querySelector<HTMLInputElement>("#confirmPassword")?.focus();
      return;
    }

    setBusy(true);
    try {
      const firstName = String(data.get("firstName") ?? "").trim();
      const lastName = String(data.get("lastName") ?? "").trim();
      const { error } = await authClient.signUp.email({
        name: `${firstName} ${lastName}`,
        email: String(data.get("email") ?? "").trim(),
        password,
        accountType: "org",
      });
      if (error) {
        showToast({
          tone: "error",
          message: userFacingError(error, "We couldn’t create the owner account. Check your details and try again."),
        });
        return;
      }

      const result = await completePlatformSetup(data);
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
          <p className="text-sm font-medium text-accent">First owner</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950">
            Set up your recruiter workspace
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">
            Create the first owner account and organisation. You can add recruiters and
            reviewers after setup.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5">
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
          <div>
            <Label htmlFor="email">Work email</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" />
          </div>
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
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Setting up workspace…" : "Create owner and organisation"}
          </Button>
        </form>
        <p className="text-xs leading-5 text-stone-500">
          Setup closes after the first organisation is created. Future users sign in or
          create an invited account through the standard account flow.
        </p>
      </CardContent>
    </Card>
  );
}
