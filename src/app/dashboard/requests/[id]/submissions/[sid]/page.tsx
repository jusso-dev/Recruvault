import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requestMeta, AuthError } from "@/lib/guards";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { loadSubmissionForReview } from "@/lib/review";
import { audit } from "@/lib/audit";
import { setSubmissionStatus, deleteSubmission } from "@/actions/submissions";
import { shareSubmission } from "@/actions/requests";
import { can } from "@/lib/rbac";
import { applicationStatusLabel } from "@/lib/application-status";
import { db } from "@/db";
import { memberships, user } from "@/db/schema";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  statusBadgeVariant,
} from "@/components/ui";

export default async function SubmissionReviewPage({
  params,
}: {
  params: Promise<{ id: string; sid: string }>;
}) {
  const { sid } = await params;
  const ctx = await requireDashboardUser();

  let data;
  try {
    data = await loadSubmissionForReview(ctx, sid);
  } catch (err) {
    if (err instanceof AuthError) notFound();
    throw err;
  }
  const { submission, request, values, documents } = data;
  const reviewers = can(ctx.role, "requests:create")
    ? (
        await db
          .select({
            userId: user.id,
            name: user.name,
            email: user.email,
            role: memberships.role,
          })
          .from(memberships)
          .innerJoin(user, eq(user.id, memberships.userId))
          .where(eq(memberships.orgId, ctx.orgId))
      ).filter((member) => member.role === "reviewer")
    : [];

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "submission.viewed",
    targetType: "submission",
    targetId: submission.id,
    ...meta,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Submission: {request.title}</h1>
          <p className="text-sm text-stone-500">
            {submission.responderEmail ?? "responder"} ·{" "}
            {submission.submittedAt?.toLocaleString("en-AU")}
          </p>
        </div>
        <Badge variant={statusBadgeVariant(submission.status)}>
          {applicationStatusLabel(submission.status)}
        </Badge>
      </div>

      {submission.purgedAt ? (
        <Card>
          <CardContent className="py-10 text-center text-stone-500">
            This submission&apos;s data was purged on{" "}
            {submission.purgedAt.toLocaleDateString("en-AU")} (crypto-shredded). The
            audit record of its handling is retained.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Structured values</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-stone-100">
                {values.map((v) => (
                  <div key={v.fieldId} className="flex justify-between gap-4 py-2 text-sm">
                    <dt className="text-stone-600">
                      {v.label}
                      {v.sensitive && (
                        <Badge variant="amber" className="ml-2">
                          PII
                        </Badge>
                      )}
                    </dt>
                    <dd className="font-medium">{v.value ?? "Not provided"}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Documents</CardTitle>
            </CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <p className="text-sm text-stone-500">No documents uploaded.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {documents.map((d) => (
                    <li key={d.documentId} className="flex items-center justify-between">
                      <span>
                        {d.label}: {d.fileName}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge variant={statusBadgeVariant(d.scanStatus)}>
                          {d.scanStatus}
                        </Badge>
                        {d.scanStatus === "clean" && (
                          <ButtonLink
                            href={`/api/documents/${d.documentId}/view`}
                            target="_blank"
                            rel="noreferrer"
                            variant="secondary"
                            size="sm"
                          >
                            View in browser
                          </ButtonLink>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-stone-500">
                Documents render in-browser through an authorised, audited route. There
                are no public URLs and no bulk raw download.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex flex-wrap items-end gap-4">
        {can(ctx.role, "submissions:view_own") && (
        <ActionForm
          action={setSubmissionStatus}
          successMessage="Application stage updated."
          className="flex items-end gap-2"
        >
          <input type="hidden" name="submissionId" value={submission.id} />
          <div>
            <label htmlFor="status" className="mb-1.5 block text-sm font-medium">
              Set status
            </label>
            <Select id="status" name="status" defaultValue={submission.status}>
              <option value="received">Received</option>
              <option value="under_review">Under review</option>
              <option value="shortlisted">Shortlisted</option>
              <option value="interview">Interview</option>
              <option value="offer">Offer</option>
              <option value="accepted">Offer accepted</option>
              <option value="placed">Placed</option>
              <option value="follow_up">Follow up needed</option>
              <option value="declined">Not progressing</option>
              <option value="withdrawn">Withdrawn</option>
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            Update
          </Button>
        </ActionForm>
        )}

        {reviewers.length > 0 && (
          <ActionForm
            action={shareSubmission}
            successMessage="Application shared with the reviewer."
            className="flex items-end gap-2"
          >
            <input type="hidden" name="submissionId" value={submission.id} />
            <div>
              <label htmlFor="reviewer" className="mb-1.5 block text-sm font-medium">
                Share with reviewer
              </label>
              <Select id="reviewer" name="userId">
                {reviewers.map((reviewer) => (
                  <option key={reviewer.userId} value={reviewer.userId}>
                    {reviewer.name} ({reviewer.email})
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="secondary">Share</Button>
          </ActionForm>
        )}

        {can(ctx.role, "deletion:action") && !submission.purgedAt && (
          <ActionForm action={deleteSubmission} successMessage="Application data deleted.">
            <input type="hidden" name="submissionId" value={submission.id} />
            <Button type="submit" variant="destructive">
              Delete (crypto-shred)
            </Button>
          </ActionForm>
        )}
      </div>
    </div>
  );
}
