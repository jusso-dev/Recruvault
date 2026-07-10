import { NextRequest } from "next/server";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { matchCandidates } from "@/lib/match";

/**
 * Find opted-in candidates matching a role's requirements. Returns opaque
 * handles and match detail only; no candidate PII is exposed.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    await resolveOrgContext(req, "requests:create");
    const body = await req.json().catch(() => {
      throw new ApiError(400, "Invalid JSON body.");
    });
    const matches = await matchCandidates(
      {
        clearanceLevel: body.clearanceLevel ? String(body.clearanceLevel) : null,
        citizenship: body.citizenship ? String(body.citizenship) : null,
        rightToWork: body.rightToWork ? String(body.rightToWork) : null,
        skills: Array.isArray(body.skills) ? body.skills.map(String) : [],
      },
      Math.min(Number(body.limit) || 20, 50),
    );
    return json({ matches });
  });
}
