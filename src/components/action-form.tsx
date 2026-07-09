"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/actions/org";

/**
 * Thin client wrapper around a server action that returns ActionResult:
 * surfaces errors inline, optionally redirects on success.
 */
export function ActionForm({
  action,
  children,
  className,
  successMessage,
  redirectTo,
  resetOnSuccess,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  successMessage?: string;
  /** Redirect target; ":id" is replaced with the returned id. */
  redirectTo?: string;
  resetOnSuccess?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await action(formData);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      if (redirectTo) {
        router.push(redirectTo.replace(":id", result.id ?? ""));
        return;
      }
      if (successMessage) setSuccess(successMessage);
      if (resetOnSuccess) form.reset();
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className={cn(pending && "opacity-60", className)}>
      {children}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="mt-2 text-sm text-emerald-700">
          {success}
        </p>
      )}
    </form>
  );
}
