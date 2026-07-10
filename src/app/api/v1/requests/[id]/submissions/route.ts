import { NextRequest } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { requests, submissions } from "@/db/schema";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { can } from "@/lib/rbac";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req);
    const { id } = await params;

    const [request] = await db
      .select({ id: requests.id, createdBy: requests.createdBy })
      .from(requests)
      .where(and(eq(requests.id, id), eq(requests.orgId, ctx.orgId)));
    if (!request) throw new ApiError(404, "Request not found.");

    const canAll = can(ctx.role, "submissions:view_all");
    const canOwn = can(ctx.role, "submissions:view_own");
    if (!canAll && !(canOwn && request.createdBy === ctx.userId)) {
      throw new ApiError(403, "Your role cannot view these submissions.");
    }

    // Metadata only; decrypted values require the review endpoints/UI.
    const rows = await db
      .select({
        id: submissions.id,
        status: submissions.status,
        submittedAt: submissions.submittedAt,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .where(and(eq(submissions.requestId, id), isNull(submissions.purgedAt)))
      .orderBy(desc(submissions.createdAt));

    return json({ submissions: rows });
  });
}
