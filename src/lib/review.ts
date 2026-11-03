import "server-only";
import { and, eq, or } from "drizzle-orm";
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
import { createDekCache, decryptFieldWithKey } from "@/lib/crypto";
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
 * Recruiters (view_own) manage only the requests they created; roles with
 * org-wide submission access manage every request in the organisation. The
 * dashboard request page applies the same rule.
 */
export function canManageRequest(
  ctx: Pick<OrgContext, "role" | "userId">,
  request: { createdBy: string | null },
): boolean {
  return can(ctx.role, "submissions:view_all") || request.createdBy === ctx.userId;
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
  // A draft holds link-wrapped values only the responder can open; it is not
  // an application yet, so it cannot be reviewed, re-statused, or shared.
  if (row.submission.status === "started") throw new AuthError("This application is still in progress.");

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

  const dekCache = createDekCache();
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
      value: v
        ? decryptFieldWithKey(v.valueEncrypted, await dekCache.getKey(v.dekId))
        : null,
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

/**
 * Organisation-side document gate, mirroring assertSubmissionAccess. Roles
 * that see every submission see every organisation document. Otherwise a
 * document is visible only when it belongs to a submission the caller may
 * review (own request, or shared with them), or, for request creators, is
 * the JD or NDA of their own request.
 */
export async function canViewOrgDocument(
  ctx: OrgContext,
  doc: { id: string; orgId: string | null },
): Promise<boolean> {
  if (doc.orgId !== ctx.orgId) return false;
  if (can(ctx.role, "submissions:view_all") && can(ctx.role, "documents:view")) return true;

  const onSubmissions = await db
    .select({ submissionId: submissionDocuments.submissionId, createdBy: requests.createdBy })
    .from(submissionDocuments)
    .innerJoin(submissions, eq(submissions.id, submissionDocuments.submissionId))
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .where(and(eq(submissionDocuments.documentId, doc.id), eq(requests.orgId, ctx.orgId)));
  for (const row of onSubmissions) {
    if (can(ctx.role, "submissions:view_own") && row.createdBy === ctx.userId) return true;
    if (await isSharedWith(row.submissionId, ctx.userId)) return true;
  }

  if (!can(ctx.role, "documents:view")) return false;
  const [ownRequest] = await db
    .select({ id: requests.id })
    .from(requests)
    .where(
      and(
        eq(requests.orgId, ctx.orgId),
        eq(requests.createdBy, ctx.userId),
        or(eq(requests.jdDocumentId, doc.id), eq(requests.ndaDocumentId, doc.id)),
      ),
    )
    .limit(1);
  return !!ownRequest;
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
