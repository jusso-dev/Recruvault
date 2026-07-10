import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { db } from "@/db";
import { organisations } from "@/db/schema";

const PROTECTED_PATHS = [
  "/dashboard",
  "/wallet",
  "/roles",
  "/documents",
  "/overview",
  "/integrations",
  "/onboarding",
  "/verify-email",
];

/** Bootstrap redirect plus coarse session gate. Data-layer guards remain authoritative. */
export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const [organisation] = await db.select({ id: organisations.id }).from(organisations).limit(1);

  if (!organisation && pathname !== "/setup") {
    return NextResponse.redirect(new URL("/setup", request.url));
  }
  if (organisation && pathname === "/setup") {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  const protectedPath = PROTECTED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  if (protectedPath && !getSessionCookie(request)) {
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/setup",
    "/sign-in",
    "/sign-up",
    "/dashboard/:path*",
    "/wallet/:path*",
    "/roles/:path*",
    "/documents/:path*",
    "/overview",
    "/integrations",
    "/onboarding",
    "/verify-email",
  ],
};
