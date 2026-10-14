import type { NextConfig } from "next";

const trustedDomains = (process.env.TRUSTED_DOMAINS || "localhost").split(",").map(d => d.trim());

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  poweredByHeader: false,
  devIndicators: process.env.PLAYWRIGHT_TEST === "1" ? false : undefined,
  images: {
    remotePatterns: trustedDomains.map((domain) => ({
      protocol: "https" as const,
      hostname: domain,
    })),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
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
