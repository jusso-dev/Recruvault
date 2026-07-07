import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Coarse session gate for authenticated areas. This only checks the session
 * cookie's presence for fast redirects — real authorisation (tenant, role,
 * ownership) is enforced in the data layer on every read (lib/guards.ts).
 */
export function middleware(request: NextRequest) {
  const cookie = getSessionCookie(request);
  if (!cookie) {
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/wallet/:path*", "/roles/:path*", "/onboarding"],
};
