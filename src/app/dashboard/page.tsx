import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import {
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  FilePlus2,
  Inbox,
} from "lucide-react";
import { db } from "@/db";
import { requests, submissions } from "@/db/schema";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { can } from "@/lib/rbac";
import { Badge, ButtonLink, Card, CardContent, statusBadgeVariant } from "@/components/ui";
import {
  DistributionChart,
  MetricLedger,
  TrendChart,
  type DistributionItem,
} from "@/components/dashboard-visuals";

const STATUS_COLOURS = {
  review: "oklch(0.68 0.13 235)",
  shortlisted: "oklch(0.77 0.14 80)",
  interview: "oklch(0.63 0.16 48)",
  offer: "oklch(0.67 0.12 115)",
  placed: "oklch(0.62 0.15 155)",
};

const DOT: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-sky-500",
  default: "bg-stone-400",
};

function weekSeries(dates: Date[], now: Date) {
  const monday = new Date(now);
  const day = monday.getDay() || 7;
  monday.setDate(monday.getDate() - day + 1);
  monday.setHours(0, 0, 0, 0);

  return Array.from({ length: 6 }, (_, index) => {
    const start = new Date(monday);
    start.setDate(start.getDate() - (5 - index) * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return {
      label: start.toLocaleDateString("en-AU", { day: "numeric", month: "short" }),
      value: dates.filter((date) => date >= start && date < end).length,
      start,
    };
  });
}

export default async function DashboardPage() {
  const ctx = await requireDashboardUser();

  const requestRows = await db
    .select({
      request: requests,
      submissionCount: sql<number>`count(${submissions.id})::int`,
    })
    .from(requests)
    .leftJoin(submissions, eq(submissions.requestId, requests.id))
    .where(eq(requests.orgId, ctx.orgId))
    .groupBy(requests.id)
    .orderBy(desc(requests.createdAt));

  const allSubmissionRows = await db
    .select({
      id: submissions.id,
      requestId: submissions.requestId,
      status: submissions.status,
      createdAt: submissions.createdAt,
      requestCreatedBy: requests.createdBy,
    })
    .from(submissions)
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .where(eq(requests.orgId, ctx.orgId));

  const seesAll = can(ctx.role, "submissions:view_all");
  const visibleRequests = seesAll
    ? requestRows
    : requestRows.filter((row) => row.request.createdBy === ctx.userId);
  const visibleSubmissions = seesAll
    ? allSubmissionRows
    : allSubmissionRows.filter((row) => row.requestCreatedBy === ctx.userId);

  const now = new Date();
  const activity = weekSeries(
    visibleSubmissions.map((row) => row.createdAt),
    now,
  );
  const thisWeek = activity.at(-1)?.value ?? 0;
  const activeRoles = visibleRequests.filter(({ request }) =>
    ["open", "closing_soon"].includes(request.status),
  ).length;
  const closingSoon = visibleRequests.filter(({ request }) => {
    if (!request.expiresAt || !["open", "closing_soon"].includes(request.status)) return false;
    const days = (request.expiresAt.getTime() - now.getTime()) / 86_400_000;
    return days >= 0 && days <= 14;
  }).length;
  const awaitingAction = visibleSubmissions.filter((row) =>
    ["received", "follow_up"].includes(row.status),
  ).length;
  const placements = visibleSubmissions.filter((row) => row.status === "placed").length;

  const distribution: DistributionItem[] = [
    {
      label: "Review",
      value: visibleSubmissions.filter((row) =>
        ["received", "under_review", "follow_up"].includes(row.status),
      ).length,
      colour: STATUS_COLOURS.review,
    },
    {
      label: "Shortlisted",
      value: visibleSubmissions.filter((row) => row.status === "shortlisted").length,
      colour: STATUS_COLOURS.shortlisted,
    },
    {
      label: "Interview",
      value: visibleSubmissions.filter((row) => row.status === "interview").length,
      colour: STATUS_COLOURS.interview,
    },
    {
      label: "Offer",
      value: visibleSubmissions.filter((row) => ["offer", "accepted"].includes(row.status)).length,
      colour: STATUS_COLOURS.offer,
    },
    {
      label: "Placed",
      value: placements,
      colour: STATUS_COLOURS.placed,
    },
  ];

  const submissionsByRequest = new Map<string, { received: number; total: number }>();
  for (const submission of visibleSubmissions) {
    const current = submissionsByRequest.get(submission.requestId) ?? { received: 0, total: 0 };
    current.total += 1;
    if (submission.status === "received") current.received += 1;
    submissionsByRequest.set(submission.requestId, current);
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-accent">
            {now.toLocaleDateString("en-AU", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
          <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">
            Placement dashboard
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-stone-500">
            Open roles, candidate progress, and placement activity across {ctx.orgName}.
          </p>
        </div>
        {can(ctx.role, "requests:create") && (
          <ButtonLink href="/dashboard/requests/new" className="w-full sm:w-auto">
            <FilePlus2 className="h-4 w-4" aria-hidden />
            New role
          </ButtonLink>
        )}
      </header>

      <MetricLedger
        items={[
          {
            label: "Active roles",
            value: activeRoles,
            detail: `${visibleRequests.length} roles total`,
          },
          {
            label: "Candidates in pipeline",
            value: visibleSubmissions.length,
            detail: `${thisWeek} added this week`,
            tone: thisWeek > 0 ? "positive" : "default",
          },
          {
            label: "Needs action",
            value: awaitingAction,
            detail: awaitingAction > 0 ? "review or follow up" : "queue clear",
            tone: awaitingAction > 0 ? "attention" : "positive",
          },
          {
            label: "Placements",
            value: placements,
            detail: closingSoon > 0 ? `${closingSoon} roles closing soon` : "completed placements",
            tone: placements > 0 ? "positive" : closingSoon > 0 ? "attention" : "default",
          },
        ]}
      />

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <Card>
          <div className="flex flex-col gap-1 border-b border-stone-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-stone-900">Pipeline activity</h2>
              <p className="mt-0.5 text-xs text-stone-500">Candidates entering roles over six weeks</p>
            </div>
            <span className="tnum text-xs text-stone-400">{visibleSubmissions.length} all time</span>
          </div>
          <CardContent className="pb-3 pt-4">
            <TrendChart points={activity} label="Candidates entering the hiring pipeline in each of the last six weeks" />
          </CardContent>
        </Card>

        <Card>
          <div className="border-b border-stone-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-stone-900">Placement pipeline</h2>
            <p className="mt-0.5 text-xs text-stone-500">Current candidate stage</p>
          </div>
          <CardContent>
            <DistributionChart items={distribution} />
          </CardContent>
        </Card>
      </section>

      <section id="caseload" aria-labelledby="caseload-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 id="caseload-heading" className="text-base font-semibold text-stone-950">
              Hiring pipeline
            </h2>
            <p className="mt-0.5 text-sm text-stone-500">
              Roles are ordered by most recently created.
            </p>
          </div>
          {awaitingAction > 0 && (
            <span className="hidden items-center gap-1.5 text-xs font-medium text-amber-700 sm:flex">
              <CircleAlert className="h-3.5 w-3.5" aria-hidden />
              {awaitingAction} candidate{awaitingAction === 1 ? "" : "s"} need action
            </span>
          )}
        </div>

        {visibleRequests.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-tint text-accent ring-1 ring-accent-tint-border">
                <Inbox className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h3 className="font-semibold text-stone-900">No roles in your pipeline</h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">
                  Add a role, invite candidates, and manage their progress through placement.
                </p>
              </div>
              {can(ctx.role, "requests:create") && (
                <ButtonLink href="/dashboard/requests/new">Create first role</ButtonLink>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_110px_120px_120px_28px] gap-4 border-b border-stone-200 bg-stone-100/65 px-5 py-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-stone-500 md:grid">
              <span>Role</span>
              <span>Candidates</span>
              <span>Closing</span>
              <span>Status</span>
              <span className="sr-only">Open</span>
            </div>
            <div className="divide-y divide-stone-100">
              {visibleRequests.map(({ request, submissionCount }) => {
                const variant = statusBadgeVariant(request.status);
                const queue = submissionsByRequest.get(request.id);
                return (
                  <Link
                    key={request.id}
                    href={`/dashboard/requests/${request.id}`}
                    className="group grid gap-3 px-5 py-4 transition-colors duration-150 hover:bg-stone-50 focus-visible:bg-stone-50 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent md:grid-cols-[minmax(0,1fr)_110px_120px_120px_28px] md:items-center md:gap-4"
                  >
                    <div className="flex min-w-0 items-start gap-3 md:items-center">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full md:mt-0 ${DOT[variant] ?? DOT.default}`}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-stone-900">{request.title}</p>
                        <p className="mt-0.5 truncate text-xs text-stone-500">
                          {queue?.received
                            ? `${queue.received} candidate${queue.received === 1 ? "" : "s"} ready for review`
                            : request.listed
                              ? "Listed to engaged job seekers"
                              : "Private invitation only"}
                        </p>
                      </div>
                    </div>
                    <div className="tnum text-sm text-stone-700">
                      <span className="mr-1 text-xs text-stone-400 md:hidden">Candidates:</span>
                      {submissionCount}
                    </div>
                    <div className="tnum text-sm text-stone-600">
                      <span className="mr-1 text-xs text-stone-400 md:hidden">Closing:</span>
                      {request.expiresAt
                        ? request.expiresAt.toLocaleDateString("en-AU", {
                            day: "numeric",
                            month: "short",
                            year: request.expiresAt.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
                          })
                        : "Not set"}
                    </div>
                    <div>
                      <Badge variant={variant}>{request.status.replaceAll("_", " ")}</Badge>
                    </div>
                    <ChevronRight
                      className="hidden h-4 w-4 text-stone-300 transition-colors group-hover:text-stone-600 md:block"
                      aria-hidden
                    />
                  </Link>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-stone-100 bg-stone-50/60 px-5 py-3 text-xs text-stone-500">
              <span className="tnum">{visibleRequests.length} roles</span>
              {can(ctx.role, "audit:view") ? (
                <Link
                  href="/dashboard/audit"
                  className="inline-flex items-center gap-1 font-medium text-stone-700 hover:text-accent"
                >
                  View activity log
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              ) : (
                <span>Access is recorded automatically</span>
              )}
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
