import { NextResponse } from "next/server";
import { buildOpenApiSpec } from "@/lib/api/openapi";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Same-origin API reference. The previous page loaded an unpinned Scalar bundle
 * from jsDelivr with unsafe-inline and unsafe-eval. This response has no
 * scripts, so it can use a strict policy and cannot be framed.
 */
export async function GET() {
  const spec = buildOpenApiSpec() as {
    info?: { title?: string; description?: string };
    paths?: Record<string, Record<string, { summary?: string }>>;
  };
  const rows = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ["get", "post", "patch", "delete"].includes(method))
      .map(
        ([method, operation]) =>
          `<tr><td><code>${escapeHtml(method.toUpperCase())}</code></td><td><code>${escapeHtml(path)}</code></td><td>${escapeHtml(operation.summary ?? "")}</td></tr>`,
      ),
  );
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(spec.info?.title ?? "Recruvault API")}</title>
</head>
<body>
  <h1>${escapeHtml(spec.info?.title ?? "Recruvault API")}</h1>
  <p>${escapeHtml(spec.info?.description ?? "")}</p>
  <p>Machine-readable spec: <a href="/api/v1/openapi.json">openapi.json</a></p>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
</body>
</html>`;
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
