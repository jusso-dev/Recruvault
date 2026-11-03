"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requests, submissionShares, submissions } from "@/db/schema";
import { requestMeta, AuthError, requireUnlockedOrg, requireEnrolledOrg } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { assertSubmissionAccess } from "@/lib/review";
import { can } from "@/lib/rbac";
import { purgeSubmission } from "@/lib/retention";
import {
  RECRUITER_APPLICATION_STATUSES,
  type RecruiterApplicationStatus,
} from "@/lib/application-status";
import type { ActionResult } from "./org";

export async function setSubmissionStatus(formData: FormData): Promise<ActionResult> {
  const ctx = await requireUnlockedOrg("submissions:view_own");
  const submissionId = String(formData.get("submissionId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!RECRUITER_APPLICATION_STATUSES.includes(status as RecruiterApplicationStatus)) {
    return { ok: false, error: "Invalid status." };
  }

  // Same ownership/share gate as review: writing status must not be broader
  // than reading the submission.
  let sub: { submission: { id: string }; request: { id: string } };
  try {
    sub = await assertSubmissionAccess(ctx, submissionId);
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    throw err;
  }

  await db
    .update(submissions)
    .set({ status: status as RecruiterApplicationStatus, updatedAt: new Date() })
    .where(eq(submissions.id, submissionId));

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: `submission.status.${status}`,
    targetType: "submission",
    targetId: submissionId,
    ...meta,
  });

  revalidatePath(`/dashboard/requests/${sub.request.id}/submissions/${submissionId}`);
  revalidatePath(`/dashboard/requests/${sub.request.id}`);
  revalidatePath("/dashboard");
  revalidatePath("/overview");
  revalidatePath("/roles");
  return { ok: true };
}

/** Compliance / admin deletion: crypto-shred a submission on request. */
export async function deleteSubmission(formData: FormData): Promise<ActionResult> {
  const ctx = await requireEnrolledOrg("deletion:action");
  const submissionId = String(formData.get("submissionId") ?? "");

  const [sub] = await db
    .select({ id: submissions.id, requestId: submissions.requestId })
    .from(submissions)
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .where(and(eq(submissions.id, submissionId), eq(requests.orgId, ctx.orgId)));
  if (!sub) return { ok: false, error: "Submission not found." };

  await purgeSubmission(submissionId, { actorType: "org_user", actorId: ctx.userId });

  revalidatePath(`/dashboard/requests/${sub.requestId}`);
  return { ok: true };
}

/**
 * Remove a reviewer's access to a submission. The request owner and
 * owners/admins can do this; like other revocations it works while locked.
 */
export async function unshareSubmission(formData: FormData): Promise<ActionResult> {
  const ctx = await requireEnrolledOrg();
  const submissionId = String(formData.get("submissionId") ?? "");
  const userId = String(formData.get("userId") ?? "");

  const [sub] = await db
    .select({ id: submissions.id, requestId: requests.id, createdBy: requests.createdBy })
    .from(submissions)
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .where(and(sql`${submissions.id}::text = ${submissionId}`, eq(requests.orgId, ctx.orgId)));
  if (!sub) return { ok: false, error: "Submission not found." };
  if (sub.createdBy !== ctx.userId && !can(ctx.role, "users:manage")) {
    return { ok: false, error: "Only the role owner or an admin can remove sharing." };
  }

  const [removed] = await db
    .delete(submissionShares)
    .where(and(eq(submissionShares.submissionId, sub.id), eq(submissionShares.userId, userId)))
    .returning({ id: submissionShares.id });
  if (!removed) return { ok: false, error: "That reviewer does not have access." };

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "submission.unshared",
    targetType: "submission",
    targetId: sub.id,
    ...meta,
  });

  revalidatePath(`/dashboard/requests/${sub.requestId}/submissions/${sub.id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}
