import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { requests, submissions } from "@/db/schema";
import { requireOrgUser } from "@/lib/guards";
import { can } from "@/lib/rbac";
import { Badge, Button, Card, CardContent, statusBadgeVariant } from "@/components/ui";

export default async function DashboardPage() {
  const ctx = await requireOrgUser();

  const rows = await db
    .select({
      request: requests,
      submissionCount: sql<number>`count(${submissions.id})::int`,
    })
    .from(requests)
    .leftJoin(submissions, eq(submissions.requestId, requests.id))
    .where(eq(requests.orgId, ctx.orgId))
    .groupBy(requests.id)
    .orderBy(desc(requests.createdAt));

  const visible = can(ctx.role, "submissions:view_all")
    ? rows
    : rows.filter((r) => r.request.createdBy === ctx.userId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Requests</h1>
        {can(ctx.role, "requests:create") && (
          <Link href="/dashboard/requests/new">
            <Button>New request</Button>
          </Link>
        )}
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-zinc-500">
            No requests yet. Create one to start collecting sensitive data securely
            instead of over email.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map(({ request, submissionCount }) => (
            <Link key={request.id} href={`/dashboard/requests/${request.id}`}>
              <Card className="mb-3 transition-shadow hover:shadow-md">
                <CardContent className="flex items-center justify-between py-4">
                  <div>
                    <div className="font-semibold">{request.title}</div>
                    <div className="text-sm text-zinc-500">
                      {submissionCount} submission{submissionCount === 1 ? "" : "s"}
                      {request.expiresAt &&
                        ` · expires ${request.expiresAt.toLocaleDateString("en-AU")}`}
                      {request.listed && " · listed"}
                    </div>
                  </div>
                  <Badge variant={statusBadgeVariant(request.status)}>
                    {request.status.replace("_", " ")}
                  </Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
