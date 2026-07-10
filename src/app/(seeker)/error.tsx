"use client";

import { Button, ButtonLink } from "@/components/ui";

/**
 * Seeker segment boundary. Failures are usually an expired session or an
 * account-loading issue; detail is shown in development only.
 */
export default function SeekerError({ reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <p className="text-sm text-stone-600">
        We couldn&apos;t load your application workspace. Your session may have expired. Try again or
        sign in.
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
