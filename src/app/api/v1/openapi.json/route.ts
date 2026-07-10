import { NextResponse } from "next/server";
import { buildOpenApiSpec } from "@/lib/api/openapi";

// Public: the spec documents the API surface but grants no access.
export async function GET() {
  return NextResponse.json(buildOpenApiSpec(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
