"use client";

import Link from "next/link";
import { Button } from "@/components/ui";

/**
 * Seeker segment boundary. Failures are usually an expired session or an
 * account-loading issue; detail is shown in development only.
 */
export default function SeekerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <p className="text-sm text-stone-600">
        We couldn&apos;t load your wallet. Your session may have expired — try again or
        sign in.
      </p>
      {process.env.NODE_ENV === "development" && (
        <pre className="max-w-full overflow-x-auto rounded bg-stone-100 p-3 text-left text-xs text-stone-700">
          {error.message}
        </pre>
      )}
      <div className="flex gap-2">
        <Button onClick={reset} variant="secondary">
          Try again
        </Button>
        <Link href="/sign-in">
          <Button>Sign in</Button>
        </Link>
      </div>
    </div>
  );
}
