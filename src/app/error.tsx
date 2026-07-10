"use client";

import Link from "next/link";
import { Button } from "@/components/ui";

/**
 * Root error boundary. Server-thrown error messages are stripped by Next in
 * production (only `digest` survives), so we show a generic message plus a
 * couple of recovery paths — never internal detail. The message is surfaced in
 * development only, to aid debugging.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-sm text-stone-600">
        An unexpected error occurred. You can try again, or head back and sign in.
      </p>
      {process.env.NODE_ENV === "development" && (
        <pre className="max-w-full overflow-x-auto rounded bg-stone-100 p-3 text-left text-xs text-stone-700">
          {error.message}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>
      )}
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Link href="/sign-in">
          <Button variant="secondary">Sign in</Button>
        </Link>
      </div>
    </main>
  );
}
