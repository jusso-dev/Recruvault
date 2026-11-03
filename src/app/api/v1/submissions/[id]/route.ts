import { NextRequest } from "next/server";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { setSubmissionStatusCore } from "@/lib/requests-service";

/** Move an application to a pipeline stage (same rules as the dashboard). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "submissions:view_own", "submissions:write");
    const { id } = await params;
    const body = await req.json().catch(() => {
      throw new ApiError(400, "Invalid JSON body.");
    });
    const status = String(body?.status ?? "");
    await setSubmissionStatusCore(ctx, id, status);
    return json({ id, status });
  });
}
