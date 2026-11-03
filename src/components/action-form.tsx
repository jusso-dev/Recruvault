"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/actions/org";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui";
import { userFacingError } from "@/lib/user-facing-errors";

export interface ConfirmOptions {
  title: string;
  /** Plain statement of what happens and whether it can be undone. */
  body: string;
  confirmLabel: string;
}

/**
 * Thin client wrapper around a server action that returns ActionResult:
 * surfaces friendly feedback, optionally confirms first, and optionally
 * redirects on success. Errors also render inline with focus moved to them.
 */
export function ActionForm({
  action,
  children,
  className,
  successMessage,
  redirectTo,
  resetOnSuccess,
  confirm,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  successMessage?: string;
  /** Redirect target; ":id" is replaced with the returned id. */
  redirectTo?: string;
  resetOnSuccess?: boolean;
  /** Ask before running an irreversible or consequential action. */
  confirm?: ConfirmOptions;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { showToast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingSubmit = useRef<{ form: HTMLFormElement; opener: HTMLElement | null } | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function fail(message: string) {
    setError(message);
    showToast({ tone: "error", message });
  }

  function run(form: HTMLFormElement) {
    const formData = new FormData(form);
    setError(null);
    startTransition(async () => {
      try {
        const result = await action(formData);
        if (!result.ok) {
          fail(userFacingError(result.error));
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
        // Browser consoles end up in screenshots and support bundles; only
        // development prints the raw error.
        if (process.env.NODE_ENV !== "production") console.error("Action failed", error);
        fail(userFacingError(error));
      }
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!confirm) {
      run(form);
      return;
    }
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    pendingSubmit.current = {
      form,
      opener: submitter instanceof HTMLElement ? submitter : (document.activeElement as HTMLElement | null),
    };
    dialogRef.current?.showModal();
  }

  function closeDialog(confirmed: boolean) {
    const submit = pendingSubmit.current;
    pendingSubmit.current = null;
    dialogRef.current?.close();
    if (confirmed && submit) run(submit.form);
    else submit?.opener?.focus();
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-busy={pending}
      className={cn(pending && "pointer-events-none opacity-60", className, error && "flex-wrap")}
    >
      {children}
      {error && (
        <p
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="flex w-full basis-full items-start gap-1.5 text-sm text-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {confirm && (
        <dialog
          ref={dialogRef}
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          // Escape fires "cancel"; route it through the same path as Cancel.
          onCancel={(e) => {
            e.preventDefault();
            closeDialog(false);
          }}
          className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-stone-200 bg-white p-0 text-stone-900 shadow-[0_12px_32px_rgba(41,37,36,0.14)] backdrop:bg-stone-950/40"
        >
          <div className="space-y-2 p-5">
            <h2 id={titleId} className="text-base font-semibold">
              {confirm.title}
            </h2>
            <p id={bodyId} className="text-sm leading-6 text-stone-600">
              {confirm.body}
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-stone-100 px-5 py-3">
            <Button type="button" variant="secondary" autoFocus onClick={() => closeDialog(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => closeDialog(true)}>
              {confirm.confirmLabel}
            </Button>
          </div>
        </dialog>
      )}
    </form>
  );
}
