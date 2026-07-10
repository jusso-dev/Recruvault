"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  title?: string;
}

interface ToastState extends ToastInput {
  id: number;
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void;
  dismissToast: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-950",
  error: "border-red-200 bg-red-50 text-red-950",
  info: "border-sky-200 bg-sky-50 text-sky-950",
};

const DEFAULT_TITLES: Record<ToastTone, string> = {
  success: "Done",
  error: "We couldn’t complete that",
  info: "Good to know",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);

  const dismissToast = useCallback(() => setToast(null), []);
  const showToast = useCallback((input: ToastInput) => {
    setToast({ ...input, tone: input.tone ?? "info", id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(
      dismissToast,
      toast.tone === "error" ? 10_000 : 6_000,
    );
    return () => window.clearTimeout(timeout);
  }, [dismissToast, toast]);

  const value = useMemo(
    () => ({ showToast, dismissToast }),
    [dismissToast, showToast],
  );
  const tone = toast?.tone ?? "info";
  const Icon = tone === "success" ? CircleCheck : tone === "error" ? CircleAlert : Info;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast && (
        <div
          className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-end sm:left-auto sm:max-w-md"
          aria-live={tone === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <div
            key={toast.id}
            role={tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex w-full items-start gap-3 rounded-lg border p-4 shadow-[0_12px_32px_rgba(41,37,36,0.14)] sm:w-[24rem]",
              TONE_STYLES[tone],
            )}
          >
            <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{toast.title ?? DEFAULT_TITLES[tone]}</p>
              <p className="mt-1 text-sm leading-5 opacity-80">{toast.message}</p>
            </div>
            <button
              type="button"
              onClick={dismissToast}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md opacity-65 transition-colors hover:bg-stone-950/5 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider.");
  return context;
}
