import { notFound } from "next/navigation";
import { requireOrgUser, requestMeta, AuthError } from "@/lib/guards";
import { loadSubmissionForReview } from "@/lib/review";
import { audit } from "@/lib/audit";
import { setSubmissionStatus, deleteSubmission } from "@/actions/submissions";
import { can } from "@/lib/rbac";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Button,
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
  const ctx = await requireOrgUser();

  let data;
  try {
    data = await loadSubmissionForReview(ctx, sid);
  } catch (err) {
    if (err instanceof AuthError) notFound();
    throw err;
  }
  const { submission, request, values, documents } = data;

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
          <h1 className="text-2xl font-bold">Submission — {request.title}</h1>
          <p className="text-sm text-zinc-500">
            {submission.responderEmail ?? "responder"} ·{" "}
            {submission.submittedAt?.toLocaleString("en-AU")}
          </p>
        </div>
        <Badge variant={statusBadgeVariant(submission.status)}>
          {submission.status.replace("_", " ")}
        </Badge>
      </div>

      {submission.purgedAt ? (
        <Card>
          <CardContent className="py-10 text-center text-zinc-500">
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
              <dl className="divide-y divide-zinc-100">
                {values.map((v) => (
                  <div key={v.fieldId} className="flex justify-between gap-4 py-2 text-sm">
                    <dt className="text-zinc-600">
                      {v.label}
                      {v.sensitive && (
                        <Badge variant="amber" className="ml-2">
                          PII
                        </Badge>
                      )}
                    </dt>
                    <dd className="font-medium">{v.value ?? "—"}</dd>
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
                <p className="text-sm text-zinc-500">No documents uploaded.</p>
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
                          <a
                            href={`/api/documents/${d.documentId}/view`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Button variant="secondary" size="sm">
                              View in browser
                            </Button>
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-zinc-500">
                Documents render in-browser through an authorised, audited route. There
                are no public URLs and no bulk raw download.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <ActionForm action={setSubmissionStatus} className="flex items-end gap-2">
          <input type="hidden" name="submissionId" value={submission.id} />
          <div>
            <label htmlFor="status" className="mb-1.5 block text-sm font-medium">
              Set status
            </label>
            <Select id="status" name="status" defaultValue={submission.status}>
              <option value="received">Received</option>
              <option value="under_review">Under review</option>
              <option value="accepted">Accepted</option>
              <option value="follow_up">Follow up needed</option>
            </Select>
          </div>
          <Button type="submit" variant="secondary">
            Update
          </Button>
        </ActionForm>

        {can(ctx.role, "deletion:action") && !submission.purgedAt && (
          <ActionForm action={deleteSubmission}>
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
