import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileClock,
  LockKeyhole,
} from "lucide-react";
import { db } from "@/db";
import {
  organisations,
  requests,
  savedRoles,
  submissions,
  walletDocuments,
  walletItems,
  walletShares,
} from "@/db/schema";
import { CAREER_DOCUMENT_KINDS, WALLET_ITEM_TYPES } from "@/lib/fields";
import { requireCandidate } from "@/lib/guards";
import {
  ACTIVE_APPLICATION_STATUSES,
  applicationStatusLabel,
} from "@/lib/application-status";
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

function monthSeries(dates: Date[], now: Date) {
  return Array.from({ length: 6 }, (_, index) => {
    const start = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return {
      label: start.toLocaleDateString("en-AU", { month: "short" }),
      value: dates.filter((date) => date >= start && date < end).length,
    };
  });
}

export default async function JobSeekerOverviewPage() {
  const ctx = await requireCandidate();

  const [items, documents, shares, applicationRows, saved] = await Promise.all([
    db
      .select({ id: walletItems.id, type: walletItems.type })
      .from(walletItems)
      .where(eq(walletItems.candidateAccountId, ctx.candidateAccountId)),
    db
      .select({
        id: walletDocuments.id,
        kind: walletDocuments.kind,
        scanStatus: walletDocuments.scanStatus,
        fileName: walletDocuments.fileName,
      })
      .from(walletDocuments)
      .where(eq(walletDocuments.candidateAccountId, ctx.candidateAccountId)),
    db
      .select({
        id: walletShares.id,
        orgId: walletShares.orgId,
        orgName: organisations.name,
        consentedAt: walletShares.consentedAt,
        revokedAt: walletShares.revokedAt,
      })
      .from(walletShares)
      .innerJoin(organisations, eq(organisations.id, walletShares.orgId))
      .where(eq(walletShares.candidateAccountId, ctx.candidateAccountId))
      .orderBy(desc(walletShares.consentedAt)),
    db
      .select({
        id: submissions.id,
        status: submissions.status,
        createdAt: submissions.createdAt,
        updatedAt: submissions.updatedAt,
        requestTitle: requests.title,
        requestStatus: requests.status,
        expiresAt: requests.expiresAt,
        orgName: organisations.name,
      })
      .from(submissions)
      .innerJoin(requests, eq(requests.id, submissions.requestId))
      .innerJoin(organisations, eq(organisations.id, requests.orgId))
      .where(eq(submissions.candidateAccountId, ctx.candidateAccountId))
      .orderBy(desc(submissions.updatedAt)),
    db
      .select({ id: savedRoles.id })
      .from(savedRoles)
      .where(eq(savedRoles.candidateAccountId, ctx.candidateAccountId)),
  ]);

  const now = new Date();
  const pendingDocuments = documents.filter((document) =>
    ["pending", "scanning"].includes(document.scanStatus),
  ).length;
  const careerDocuments = documents.filter((document) =>
    CAREER_DOCUMENT_KINDS.has(document.kind),
  );
  const cleanCareerDocuments = careerDocuments.filter(
    (document) => document.scanStatus === "clean",
  ).length;
  const hasResume = documents.some(
    (document) => document.kind === "resume" && document.scanStatus === "clean",
  );
  const profileSteps = WALLET_ITEM_TYPES.length + 1;
  const profileReadiness = Math.round(
    ((items.length + (hasResume ? 1 : 0)) / profileSteps) * 100,
  );
  const activeRoles = applicationRows.filter((row) =>
    ACTIVE_APPLICATION_STATUSES.some((status) => status === row.status),
  ).length;
  const drafts = applicationRows.filter((row) => row.status === "started");
  const followUps = applicationRows.filter((row) => row.status === "follow_up");
  const missingCredentialCount = Math.max(WALLET_ITEM_TYPES.length - items.length, 0);
  const activity = monthSeries(
    [...applicationRows.map((row) => row.createdAt), ...shares.map((share) => share.consentedAt)],
    now,
  );

  const distribution: DistributionItem[] = [
    {
      label: "Review",
      value: applicationRows.filter((row) =>
        ["received", "under_review", "follow_up"].includes(row.status),
      ).length,
      colour: STATUS_COLOURS.review,
    },
    {
      label: "Shortlisted",
      value: applicationRows.filter((row) => row.status === "shortlisted").length,
      colour: STATUS_COLOURS.shortlisted,
    },
    {
      label: "Interview",
      value: applicationRows.filter((row) => row.status === "interview").length,
      colour: STATUS_COLOURS.interview,
    },
    {
      label: "Offer",
      value: applicationRows.filter((row) => ["offer", "accepted"].includes(row.status)).length,
      colour: STATUS_COLOURS.offer,
    },
    {
      label: "Placed",
      value: applicationRows.filter((row) => row.status === "placed").length,
      colour: STATUS_COLOURS.placed,
    },
  ];

  const firstName = ctx.userName.split(/\s+/)[0] || "there";

  return (
    <div className="space-y-8">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-accent">Welcome back, {firstName}</p>
          <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">
            Your application dashboard
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-stone-500">
            Track every application and keep your resumes, cover letters, and profile ready.
          </p>
        </div>
        <ButtonLink href="/documents" variant="secondary" className="w-full sm:w-auto">
          <LockKeyhole className="h-4 w-4" aria-hidden />
          Manage career documents
        </ButtonLink>
      </header>

      <MetricLedger
        items={[
          {
            label: "Active applications",
            value: activeRoles,
            detail: `${applicationRows.length} applications total`,
          },
          {
            label: "Saved roles",
            value: saved.length,
            detail: "for later",
          },
          {
            label: "Profile ready",
            value: `${profileReadiness}%`,
            detail: hasResume ? "resume on file" : "resume needed",
            tone: profileReadiness >= 80 ? "positive" : "attention",
          },
          {
            label: "Career documents",
            value: cleanCareerDocuments,
            detail: `${careerDocuments.length} uploaded`,
            tone: hasResume ? "positive" : "attention",
          },
        ]}
      />

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.85fr)]">
        <Card>
          <div className="flex items-center justify-between gap-4 border-b border-stone-100 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-stone-900">Application activity</h2>
              <p className="mt-0.5 text-xs text-stone-500">Applications and document sharing over six months</p>
            </div>
            <span className="tnum text-xs text-stone-400">
              {applicationRows.length + shares.length} events
            </span>
          </div>
          <CardContent className="pb-3 pt-4">
            <TrendChart points={activity} label="Applications and document sharing events in each of the last six months" />
          </CardContent>
        </Card>

        <Card>
          <div className="border-b border-stone-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-stone-900">Application pipeline</h2>
            <p className="mt-0.5 text-xs text-stone-500">Where your applications stand</p>
          </div>
          <CardContent>
            <DistributionChart items={distribution} />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.75fr)]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b border-stone-100 px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-stone-900">Recent applications</h2>
              <p className="mt-0.5 text-xs text-stone-500">Your latest applications and drafts</p>
            </div>
            <Link
              href="/roles"
              className="inline-flex items-center gap-1 text-xs font-semibold text-stone-600 hover:text-accent"
            >
              All applications
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
          {applicationRows.length === 0 ? (
            <CardContent className="py-10 text-center">
              <p className="text-sm font-medium text-stone-800">No applications yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">
                Applications appear here after you start or submit for a role.
              </p>
            </CardContent>
          ) : (
            <div className="divide-y divide-stone-100">
              {applicationRows.slice(0, 5).map((row) => (
                <div key={row.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-stone-900">{row.requestTitle}</p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {row.orgName}
                      {row.expiresAt &&
                        ` · closes ${row.expiresAt.toLocaleDateString("en-AU", {
                          day: "numeric",
                          month: "short",
                        })}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                      <Badge variant={statusBadgeVariant(row.status)}>{applicationStatusLabel(row.status)}</Badge>
                    <ChevronRight className="h-4 w-4 text-stone-300" aria-hidden />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="border-b border-stone-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-stone-900">Next actions</h2>
            <p className="mt-0.5 text-xs text-stone-500">Keep your applications moving</p>
          </div>
          <CardContent className="p-0">
            <ul className="divide-y divide-stone-100">
              {drafts.length > 0 && (
                <li className="flex gap-3 px-5 py-4">
                  <FileClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-stone-800">
                      Finish {drafts.length} draft{drafts.length === 1 ? "" : "s"}
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-stone-500">Reopen the secure link before it expires.</p>
                  </div>
                </li>
              )}
              {followUps.length > 0 && (
                <li className="flex gap-3 px-5 py-4">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-stone-800">
                      {followUps.length} follow-up{followUps.length === 1 ? "" : "s"} requested
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-stone-500">Check your email for the recruiter&apos;s request.</p>
                  </div>
                </li>
              )}
              {(missingCredentialCount > 0 || !hasResume) && (
                <li className="flex gap-3 px-5 py-4">
                  <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-stone-500" aria-hidden />
                  <div>
                      <p className="text-sm font-medium text-stone-800">Complete your profile and documents</p>
                    <p className="mt-0.5 text-xs leading-5 text-stone-500">
                      Add a current resume and reusable details to make future applications faster.
                    </p>
                    <Link href="/documents" className="mt-2 inline-block text-xs font-semibold text-accent hover:underline">
                      Review career documents
                    </Link>
                  </div>
                </li>
              )}
              {pendingDocuments > 0 && (
                <li className="flex gap-3 px-5 py-4">
                  <FileClock className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-stone-800">
                      {pendingDocuments} document{pendingDocuments === 1 ? "" : "s"} scanning
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-stone-500">They will be available after security checks.</p>
                  </div>
                </li>
              )}
              {drafts.length === 0 &&
                followUps.length === 0 &&
                missingCredentialCount === 0 &&
                hasResume &&
                pendingDocuments === 0 && (
                  <li className="flex gap-3 px-5 py-6">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                    <div>
                      <p className="text-sm font-medium text-stone-800">You&apos;re up to date</p>
                      <p className="mt-0.5 text-xs leading-5 text-stone-500">No action is needed right now.</p>
                    </div>
                  </li>
                )}
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
