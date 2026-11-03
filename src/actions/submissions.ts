"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requests, submissionShares, submissions } from "@/db/schema";
import { requestMeta, AuthError, requireUnlockedOrg, requireEnrolledOrg } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { purgeSubmission } from "@/lib/retention";
import { setSubmissionStatusCore } from "@/lib/requests-service";
import { ApiError } from "@/lib/api/http";
import type { ActionResult } from "./org";

export async function setSubmissionStatus(formData: FormData): Promise<ActionResult> {
  const ctx = await requireUnlockedOrg("submissions:view_own");
  const submissionId = String(formData.get("submissionId") ?? "");
  let requestId: string;
  try {
    ({ requestId } = await setSubmissionStatusCore(
      ctx,
      submissionId,
      String(formData.get("status") ?? ""),
      await requestMeta(),
    ));
  } catch (err) {
    if (err instanceof AuthError || err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }

  revalidatePath(`/dashboard/requests/${requestId}/submissions/${submissionId}`);
  revalidatePath(`/dashboard/requests/${requestId}`);
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
