"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui";

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();

  if (!copied) throw new Error("Copy was not available.");
}

export function CopyAgentPrompt({
  prompt,
  label = "Copy agent prompt",
  copiedLabel = "Copied",
  toastTitle = "Ready to paste",
  toastMessage = "The agent setup prompt has been copied.",
}: {
  prompt: string;
  label?: string;
  copiedLabel?: string;
  toastTitle?: string;
  toastMessage?: string;
}) {
  const [copied, setCopied] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 3_000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function handleCopy() {
    try {
      await copyText(prompt);
      setCopied(true);
      showToast({
        tone: "success",
        title: toastTitle,
        message: toastMessage,
      });
    } catch {
      showToast({
        tone: "error",
        message: "We could not access your clipboard. Select the prompt and copy it manually.",
      });
    }
  }

  return (
    <Button type="button" variant="secondary" size="sm" onClick={handleCopy}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? copiedLabel : label}
    </Button>
  );
}
