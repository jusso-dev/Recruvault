import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { requests } from "@/db/schema";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { createRequestCore } from "@/lib/requests-service";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "requests:create");
    const rows = await db
      .select({
        id: requests.id,
        title: requests.title,
        status: requests.status,
        listed: requests.listed,
        expiresAt: requests.expiresAt,
        createdAt: requests.createdAt,
      })
      .from(requests)
      .where(eq(requests.orgId, ctx.orgId))
      .orderBy(desc(requests.createdAt));
    return json({ requests: rows });
  });
}

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "requests:create");
    const body = await req.json().catch(() => {
      throw new ApiError(400, "Invalid JSON body.");
    });
    const id = await createRequestCore(ctx, {
      title: String(body.title ?? ""),
      description: body.description ?? null,
      consentPurpose: body.consentPurpose ?? null,
      listed: !!body.listed,
      jdViewMode: body.jdViewMode === "allow_download" ? "allow_download" : "view_only",
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      fieldKeys: Array.isArray(body.fieldKeys) ? body.fieldKeys.map(String) : [],
      customLabels: Array.isArray(body.customLabels) ? body.customLabels.map(String) : [],
      includeDefaults: body.includeDefaults !== false,
    });
    return json({ id }, 201);
  });
}
