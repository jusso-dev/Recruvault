"use client";

import { useTransition } from "react";
import { saveDraft } from "@/actions/link";
import { Button } from "@/components/ui";
import { useToast } from "@/components/toast";
import { userFacingError } from "@/lib/user-facing-errors";

/**
 * Saves the enclosing form's structured answers as a draft without submitting.
 * Reads the associated <form> directly, so it drops into the existing response
 * form without turning the whole page into a client component.
 */
export function SaveDraftButton() {
  const [pending, start] = useTransition();
  const { showToast } = useToast();

  return (
    <div>
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={pending}
        onClick={(e) => {
          const form = e.currentTarget.form;
          if (!form) return;
          const fd = new FormData(form);
          start(async () => {
            try {
              const res = await saveDraft(fd);
              if (!res.ok) {
                showToast({
                  tone: "error",
                  message: userFacingError(res.error, "We couldn’t save your draft. Please try again."),
                });
                return;
              }
              showToast({
                tone: "success",
                title: "Draft saved",
                message:
                  "Reopen this link before it expires to finish. You’ll need to attach files again when you submit.",
              });
            } catch (error) {
              showToast({ tone: "error", message: userFacingError(error) });
            }
          });
        }}
      >
        {pending ? "Saving…" : "Save and finish later"}
      </Button>
    </div>
  );
}
