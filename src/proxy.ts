import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { buildContentSecurityPolicy, trustedConnectSources } from "@/lib/csp";
import { corsHeaders } from "@/lib/cors";

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
function pageCsp(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev,
    connectSources: trustedConnectSources(process.env.TRUSTED_DOMAINS || "localhost", isDev),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  return { policy, requestHeaders };
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith("/api/v1/")) {
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request) ?? {};
      return new NextResponse(null, { status: 204, headers });
    }
    const response = NextResponse.next();
    const headers = corsHeaders(request);
    if (headers) {
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    }
    return response;
  }
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const { policy, requestHeaders } = pageCsp(request);
  const [owner] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.role, "owner"))
    .limit(1);

  if (!owner && pathname !== "/setup") {
    const response = NextResponse.redirect(new URL("/setup", request.url));
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }
  if (owner && pathname === "/setup") {
    const response = NextResponse.redirect(new URL("/sign-in", request.url));
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }

  const protectedPath = PROTECTED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  if (protectedPath && !getSessionCookie(request)) {
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("next", pathname);
    const response = NextResponse.redirect(url);
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
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
    "/vault/:path*",
    "/account-deleted",
    "/api/v1/:path*",
  ],
};
