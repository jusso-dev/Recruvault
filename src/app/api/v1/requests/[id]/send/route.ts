import { NextRequest } from "next/server";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { sendRequestCore } from "@/lib/requests-service";

/** Send a request's secure link to an email or a matched candidate handle. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "requests:create");
    const { id } = await params;
    const body = await req.json().catch(() => {
      throw new ApiError(400, "Invalid JSON body.");
    });
    await sendRequestCore(ctx, id, {
      email: body.email ? String(body.email) : undefined,
      candidateHandle: body.candidateHandle ? String(body.candidateHandle) : undefined,
    });
    return json({ ok: true });
  });
}
