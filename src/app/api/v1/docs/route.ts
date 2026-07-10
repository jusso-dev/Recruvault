import { NextResponse } from "next/server";

/**
 * Interactive API reference (Scalar). Served with its own CSP (this path is
 * excluded from the global policy in next.config) so the reference renderer can
 * load; it reads the public spec at /api/v1/openapi.json.
 */
export async function GET() {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Recruvault API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: https:",
        "connect-src 'self' https://cdn.jsdelivr.net",
      ].join("; "),
    },
  });
}
