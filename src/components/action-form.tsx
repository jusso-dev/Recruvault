"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/actions/org";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";

/**
 * Thin client wrapper around a server action that returns ActionResult:
 * surfaces friendly toast feedback and optionally redirects on success.
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
  const { showToast } = useToast();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const formData = new FormData(form);
    startTransition(async () => {
      try {
        const result = await action(formData);
        if (!result.ok) {
          showToast({
            tone: "error",
            message: userFacingError(result.error),
          });
          return;
        }
        if (successMessage) {
          showToast({ tone: "success", message: successMessage });
        }
        if (resetOnSuccess) form.reset();
        if (redirectTo) {
          router.push(redirectTo.replace(":id", result.id ?? ""));
          return;
        }
        router.refresh();
      } catch (error) {
        console.error("Action failed", error);
        showToast({
          tone: "error",
          message: userFacingError(error),
        });
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-busy={pending}
      className={cn(pending && "pointer-events-none opacity-60", className)}
    >
      {children}
    </form>
  );
}
