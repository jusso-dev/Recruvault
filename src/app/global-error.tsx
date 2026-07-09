"use client";

/**
 * Catches errors thrown in the root layout itself (where the normal error
 * boundary can't render). Must supply its own <html>/<body>.
 */
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center text-zinc-900">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="text-sm text-zinc-600">
          The application failed to load. Please try again.
        </p>
        <button
          onClick={reset}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
