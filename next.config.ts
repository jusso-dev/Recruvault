import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const trustedDomains = (process.env.TRUSTED_DOMAINS || "localhost").split(",").map(d => d.trim());

// Dev needs 'unsafe-eval' (React/Turbopack debugging) and a websocket source
// for HMR; production stays strict.
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const trustedDomainsStr = trustedDomains.map(d => `https://${d}`).join(" ");
const connectSrc = isDev
  ? `connect-src 'self' ws: ${trustedDomainsStr}`
  : `connect-src 'self' ${trustedDomainsStr}`;

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  poweredByHeader: false,
  devIndicators: process.env.PLAYWRIGHT_TEST === "1" ? false : undefined,
  images: {
    remotePatterns: trustedDomains.map(domain => ({
      protocol: "https",
      hostname: domain,
    })) as any,
  },
  async headers() {
    return [
      {
        source: "/api/(.*)",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, PATCH, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
      {
        // Everything except the API docs page, which sets its own CSP so the
        // self-contained Scalar reference can load without weakening the global
        // policy.
        source: "/((?!api/v1/docs).*)",
        headers: [
          // HSTS: TLS 1.2+ is enforced at the load balancer; this pins browsers.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            // 'unsafe-inline' scripts are needed for Next hydration; nonce-based
            // CSP is a follow-up. Document-view routes override frame-ancestors
            // in their own handler so inline PDFs still render.
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              connectSrc,
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "frame-src 'self'",
              "upgrade-insecure-requests",
            ].join("; "),
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
