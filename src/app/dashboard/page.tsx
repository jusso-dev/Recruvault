import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { ChevronRight, FilePlus2 } from "lucide-react";
import { db } from "@/db";
import { requests, submissions } from "@/db/schema";
import { requireOrgUser } from "@/lib/guards";
import { can } from "@/lib/rbac";
import { Badge, Button, Card, CardContent, statusBadgeVariant } from "@/components/ui";

const DOT: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-sky-500",
  default: "bg-stone-400",
};

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
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-stone-900">Requests</h1>
          <p className="mt-1 text-sm text-stone-500">
            Secure, expiring links that collect clearance and identity evidence, never
            over email.
          </p>
        </div>
        {can(ctx.role, "requests:create") && (
          <Link href="/dashboard/requests/new">
            <Button>New request</Button>
          </Link>
        )}
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-tint text-accent">
              <FilePlus2 className="h-5 w-5" aria-hidden />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-stone-900">No requests yet</h2>
              <p className="mx-auto max-w-md text-sm text-stone-500">
                Create a secure request to collect clearance details, ID, and
                right-to-work evidence through an encrypted, expiring, audited link.
              </p>
            </div>
            {can(ctx.role, "requests:create") && (
              <Link href="/dashboard/requests/new" className="pt-1">
                <Button>Create your first request</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {visible.map(({ request, submissionCount }) => {
            const variant = statusBadgeVariant(request.status);
            return (
              <Link key={request.id} href={`/dashboard/requests/${request.id}`} className="block">
                <Card className="transition-colors hover:border-stone-300 hover:bg-stone-50/60">
                  <CardContent className="flex items-center justify-between gap-4 py-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${DOT[variant] ?? DOT.default}`}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-stone-900">
                          {request.title}
                        </div>
                        <div className="tnum mt-0.5 text-sm text-stone-500">
                          {submissionCount} submission{submissionCount === 1 ? "" : "s"}
                          {request.expiresAt &&
                            ` · expires ${request.expiresAt.toLocaleDateString("en-AU")}`}
                          {request.listed && " · listed"}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge variant={variant}>{request.status.replace("_", " ")}</Badge>
                      <ChevronRight className="h-4 w-4 text-stone-400" aria-hidden />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
