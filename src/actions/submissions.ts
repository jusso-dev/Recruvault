"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { requests, submissions } from "@/db/schema";
import { requireOrgUser, requestMeta, AuthError } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { assertSubmissionAccess } from "@/lib/review";
import { purgeSubmission } from "@/lib/retention";
import type { ActionResult } from "./org";

export async function setSubmissionStatus(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("submissions:view_own");
  const submissionId = String(formData.get("submissionId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["received", "under_review", "accepted", "follow_up"].includes(status)) {
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
    .set({ status: status as "received" | "under_review" | "accepted" | "follow_up" })
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
  return { ok: true };
}

/** Compliance / admin deletion: crypto-shred a submission on request. */
export async function deleteSubmission(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("deletion:action");
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
