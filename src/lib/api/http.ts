import "server-only";
import { NextResponse } from "next/server";
import { AuthError } from "@/lib/guards";
import { corsHeaders } from "@/lib/cors";

/** 4xx the caller can fix (bad body, missing field, unknown id). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class RateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter = 60) {
    super("Too many requests.");
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

const UNAUTHENTICATED =
  /Invalid, expired, or revoked API key|must be replaced|issued before encryption enrollment|Sign in required/i;

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/**
 * Wrap a v1 handler: turn AuthError into 401/403 and ApiError into its status,
 * and let unexpected errors bubble to Next's 500 (which logs them).
 */
export async function handle(
  fn: () => Promise<NextResponse>,
  request?: Request,
): Promise<NextResponse> {
  try {
    const response = await fn();
    return withCors(response, request);
  } catch (err) {
    if (err instanceof RateLimitError) {
      const response = NextResponse.json(
        { error: err.message, retryAfterSeconds: err.retryAfter },
        { status: 429 },
      );
      response.headers.set("Retry-After", String(err.retryAfter));
      return withCors(response, request);
    }
    if (err instanceof ApiError) {
      return withCors(NextResponse.json({ error: err.message }, { status: err.status }), request);
    }
    if (err instanceof AuthError) {
      // 401: the credential itself is unusable (replace it). 403: valid, but
      // the scope, role, verification, or vault state does not allow this.
      const status = UNAUTHENTICATED.test(err.message) ? 401 : 403;
      return withCors(NextResponse.json({ error: err.message }, { status }), request);
    }
    throw err;
  }
}

function withCors(response: NextResponse, request?: Request): NextResponse {
  if (!request) return response;
  const headers = corsHeaders(request);
  if (!headers) return response;
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
