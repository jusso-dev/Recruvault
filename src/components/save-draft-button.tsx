"use client";

import { useState, useTransition } from "react";
import { saveDraft } from "@/actions/link";
import { Button } from "@/components/ui";

/**
 * Saves the enclosing form's structured answers as a draft without submitting.
 * Reads the associated <form> directly, so it drops into the existing response
 * form without turning the whole page into a client component.
 */
export function SaveDraftButton() {
  const [pending, start] = useTransition();
  const [state, setState] = useState<"idle" | "saved" | "error">("idle");

  return (
    <div className="space-y-1">
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
          setState("idle");
          start(async () => {
            const res = await saveDraft(fd);
            setState(res.ok ? "saved" : "error");
          });
        }}
      >
        {pending ? "Saving…" : "Save and finish later"}
      </Button>
      {state === "saved" && (
        <p className="text-center text-xs text-emerald-700">
          Draft saved. Reopen this link any time before it expires to finish. Files
          need to be re-attached when you submit.
        </p>
      )}
      {state === "error" && (
        <p className="text-center text-xs text-red-600">
          Could not save your draft. Please try again.
        </p>
      )}
    </div>
  );
}
