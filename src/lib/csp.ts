/**
 * Per-request Content-Security-Policy. Next.js reads the nonce from the
 * request CSP header and applies it while rendering. Production scripts do
 * not allow unsafe-inline or unsafe-eval. Styles keep a nonce; Tailwind is
 * served from stylesheets.
 */

export function buildContentSecurityPolicy(opts: {
  nonce: string;
  isDev: boolean;
  connectSources: string[];
}): string {
  const connect = ["'self'", ...opts.connectSources].join(" ");
  const script = [
    "script-src 'self'",
    `'nonce-${opts.nonce}'`,
    "'strict-dynamic'",
    opts.isDev ? "'unsafe-eval'" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    "default-src 'self'",
    script,
    `style-src 'self' 'nonce-${opts.nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'self'",
  ].join("; ");
}

export function trustedConnectSources(trustedDomains: string, isDev: boolean): string[] {
  const https = trustedDomains
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => `https://${domain}`);
  return isDev ? ["ws:", ...https] : https;
}
