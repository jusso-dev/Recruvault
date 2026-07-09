import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  documents,
  requestFields,
  requests,
  submissionDocuments,
  submissions,
  submissionShares,
  submissionValues,
} from "@/db/schema";
import { decryptField } from "@/lib/crypto";
import { can } from "@/lib/rbac";
import type { OrgContext } from "@/lib/guards";
import { AuthError } from "@/lib/guards";

export interface DecryptedValue {
  fieldId: string;
  key: string;
  label: string;
  type: string;
  sensitive: boolean;
  value: string | null;
}

export interface SubmissionDocumentRef {
  fieldId: string;
  label: string;
  documentId: string;
  fileName: string;
  scanStatus: string;
}

/**
 * Load a submission for review with tenant + role checks applied in the data
 * layer. Recruiters see their own/team requests; reviewers only submissions
 * explicitly shared with them; admins/owners/compliance see all (org-scoped).
 */
/**
 * Tenant + ownership/share gate for a single submission. Throws AuthError when
 * the caller may not access it. Returns the submission and its request so
 * callers (review render, status mutation) share one authorisation path.
 */
export async function assertSubmissionAccess(ctx: OrgContext, submissionId: string) {
  const [row] = await db
    .select({ submission: submissions, request: requests })
    .from(submissions)
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .where(and(eq(submissions.id, submissionId), eq(requests.orgId, ctx.orgId)));
  if (!row) throw new AuthError("Submission not found.");

  if (can(ctx.role, "submissions:view_all")) {
    // ok
  } else if (can(ctx.role, "submissions:view_own")) {
    if (row.request.createdBy !== ctx.userId) {
      const shared = await isSharedWith(submissionId, ctx.userId);
      if (!shared) throw new AuthError("You can only view submissions for your own requests.");
    }
  } else {
    const shared = await isSharedWith(submissionId, ctx.userId);
    if (!shared) throw new AuthError("This submission has not been shared with you.");
  }

  return row;
}

export async function loadSubmissionForReview(ctx: OrgContext, submissionId: string) {
  const row = await assertSubmissionAccess(ctx, submissionId);

  const fields = await db
    .select()
    .from(requestFields)
    .where(eq(requestFields.requestId, row.request.id))
    .orderBy(requestFields.sortOrder);

  const values = await db
    .select()
    .from(submissionValues)
    .where(eq(submissionValues.submissionId, submissionId));

  const decrypted: DecryptedValue[] = [];
  for (const f of fields) {
    if (f.type === "file_upload") continue;
    const v = values.find((x) => x.fieldId === f.id);
    decrypted.push({
      fieldId: f.id,
      key: f.key,
      label: f.label,
      type: f.type,
      sensitive: f.sensitive,
      value: v ? await decryptField(v.valueEncrypted, v.dekId) : null,
    });
  }

  const docs: SubmissionDocumentRef[] = (
    await db
      .select({
        fieldId: submissionDocuments.fieldId,
        documentId: submissionDocuments.documentId,
        fileName: documents.fileName,
        scanStatus: documents.scanStatus,
      })
      .from(submissionDocuments)
      .innerJoin(documents, eq(documents.id, submissionDocuments.documentId))
      .where(eq(submissionDocuments.submissionId, submissionId))
  ).map((d) => ({
    ...d,
    label: fields.find((f) => f.id === d.fieldId)?.label ?? "Upload",
  }));

  return { submission: row.submission, request: row.request, values: decrypted, documents: docs };
}

async function isSharedWith(submissionId: string, userId: string): Promise<boolean> {
  const [share] = await db
    .select({ id: submissionShares.id })
    .from(submissionShares)
    .where(
      and(
        eq(submissionShares.submissionId, submissionId),
        eq(submissionShares.userId, userId),
      ),
    );
  return !!share;
}
