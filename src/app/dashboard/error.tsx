"use client";

import { Button, ButtonLink } from "@/components/ui";

/**
 * Dashboard (org) segment boundary. Most failures here are authorisation
 * related — no session, unverified email, no/ambiguous org membership, or a
 * role that lacks the permission — so the primary recovery is signing in.
 * Detail is shown in development only; production never leaks internals.
 */
export default function DashboardError({ reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-bold">You can&apos;t view this</h1>
      <p className="text-sm text-stone-600">
        Your session may have expired, your email may be unverified, or your role
        doesn&apos;t allow this. Sign in again, or contact your organisation&apos;s owner.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset} variant="secondary">
          Try again
        </Button>
        <ButtonLink href="/sign-in">Sign in</ButtonLink>
      </div>
    </div>
  );
}
