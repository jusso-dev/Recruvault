import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { requestFields, requests } from "@/db/schema";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "requests:create");
    const { id } = await params;
    const [request] = await db
      .select({
        id: requests.id,
        title: requests.title,
        description: requests.description,
        status: requests.status,
        listed: requests.listed,
        jdViewMode: requests.jdViewMode,
        jdDocumentId: requests.jdDocumentId,
        expiresAt: requests.expiresAt,
        createdAt: requests.createdAt,
      })
      .from(requests)
      .where(and(eq(requests.id, id), eq(requests.orgId, ctx.orgId)));
    if (!request) throw new ApiError(404, "Request not found.");

    const fields = await db
      .select({
        key: requestFields.key,
        type: requestFields.type,
        label: requestFields.label,
        required: requestFields.required,
      })
      .from(requestFields)
      .where(eq(requestFields.requestId, id))
      .orderBy(requestFields.sortOrder);

    return json({ ...request, fields });
  });
}
