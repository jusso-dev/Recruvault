import "server-only";
import { NextResponse } from "next/server";
import { AuthError } from "@/lib/guards";

/** 4xx the caller can fix (bad body, missing field, unknown id). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/**
 * Wrap a v1 handler: turn AuthError into 401/403 and ApiError into its status,
 * and let unexpected errors bubble to Next's 500 (which logs them).
 */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof AuthError) {
      const status = /API key|Sign in required/i.test(err.message) ? 401 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
