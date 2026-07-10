import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { organisations, requests, submissions } from "@/db/schema";
import { resolveCandidateContext } from "@/lib/api-auth";
import { applicationStatusLabel } from "@/lib/application-status";
import { handle, json } from "@/lib/api/http";

/** List only the authenticated job seeker's own applications. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await resolveCandidateContext(req);
    const rows = await db
      .select({
        id: submissions.id,
        roleId: requests.id,
        roleTitle: requests.title,
        organisation: organisations.name,
        status: submissions.status,
        submittedAt: submissions.submittedAt,
        updatedAt: submissions.updatedAt,
      })
      .from(submissions)
      .innerJoin(requests, eq(requests.id, submissions.requestId))
      .innerJoin(organisations, eq(organisations.id, requests.orgId))
      .where(eq(submissions.candidateAccountId, ctx.candidateAccountId))
      .orderBy(desc(submissions.updatedAt));

    return json({
      applications: rows.map((row) => ({
        ...row,
        statusLabel: applicationStatusLabel(row.status),
      })),
    });
  });
}
