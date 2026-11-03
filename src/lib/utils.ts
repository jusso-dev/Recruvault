import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A same-origin path for post-auth redirects, or null. Browsers strip tab and
 * newline characters while parsing, so `/\t/evil.example` would become
 * `//evil.example`; strip them first, then require the resolved URL to stay on
 * the placeholder origin.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/[\t\n\r]/g, "");
  if (!cleaned || !cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) return null;
  try {
    const url = new URL(cleaned, "http://same-origin.invalid");
    if (url.origin !== "http://same-origin.invalid") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
