"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  jobAlertSubscriptions,
  recruiterMatchSettings,
  requests,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireCandidate, requireOrgUser, requestMeta } from "@/lib/guards";
import { EMPLOYMENT_TYPES, WORK_ARRANGEMENTS } from "@/lib/role-metadata";
import { sendEvent, sendEvents } from "@/inngest/client";
import type { ActionResult } from "@/actions/org";

function commaList(value: FormDataEntryValue | null, limit: number) {
  return [...new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )].slice(0, limit);
}

export async function updateRecruiterMatchSettings(
  formData: FormData,
): Promise<ActionResult> {
  const ctx = await requireOrgUser("requests:create");
  const enabled = formData.get("enabled") === "on";
  const minimumMatchScore = Number(formData.get("minimumMatchScore") ?? 50);
  if (!Number.isInteger(minimumMatchScore) || minimumMatchScore < 1 || minimumMatchScore > 100) {
    return { ok: false, error: "Choose a minimum match score between 1% and 100%." };
  }

  await db
    .insert(recruiterMatchSettings)
    .values({
      orgId: ctx.orgId,
      enabled,
      minimumMatchScore,
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: recruiterMatchSettings.orgId,
      set: { enabled, minimumMatchScore, updatedBy: ctx.userId, updatedAt: new Date() },
    });

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: enabled ? "job_match.recruiter_enabled" : "job_match.recruiter_disabled",
    targetType: "organisation",
    targetId: ctx.orgId,
    ...meta,
  });

  if (enabled) {
    const listedRoles = await db
      .select({ requestId: requests.id })
      .from(requests)
      .where(
        and(
          eq(requests.orgId, ctx.orgId),
          eq(requests.listed, true),
          inArray(requests.status, ["open", "closing_soon"]),
        ),
      );
    if (listedRoles.length > 0) {
      await sendEvents("job-alert/role-listed", listedRoles);
    }
  }

  revalidatePath("/dashboard/job-alerts");
  return { ok: true };
}

export async function updateJobAlertSubscription(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  const enabled = formData.get("enabled") === "on";
  const skills = commaList(formData.get("skills"), 30);
  const locations = commaList(formData.get("locations"), 10);
  const employmentTypes = formData.getAll("employmentTypes").map(String);
  const workArrangements = formData.getAll("workArrangements").map(String);
  const minimumSalaryRaw = String(formData.get("minimumSalary") ?? "").trim();
  const minimumSalary = minimumSalaryRaw ? Number(minimumSalaryRaw) : null;

  if (enabled && skills.length === 0) {
    return { ok: false, error: "Add at least one skill or interest before enabling alerts." };
  }
  if (skills.some((skill) => skill.length > 80) || locations.some((location) => location.length > 120)) {
    return { ok: false, error: "Keep skills under 80 characters and locations under 120 characters." };
  }
  if (employmentTypes.some((value) => !EMPLOYMENT_TYPES.includes(value as never))) {
    return { ok: false, error: "Choose a supported employment type." };
  }
  if (workArrangements.some((value) => !WORK_ARRANGEMENTS.includes(value as never))) {
    return { ok: false, error: "Choose a supported work arrangement." };
  }
  if (minimumSalary != null && (!Number.isInteger(minimumSalary) || minimumSalary < 0)) {
    return { ok: false, error: "Minimum salary or rate must be a whole positive number." };
  }

  await db
    .insert(jobAlertSubscriptions)
    .values({
      candidateAccountId: ctx.candidateAccountId,
      enabled,
      skills,
      locations,
      employmentTypes,
      workArrangements,
      minimumSalary,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: jobAlertSubscriptions.candidateAccountId,
      set: {
        enabled,
        skills,
        locations,
        employmentTypes,
        workArrangements,
        minimumSalary,
        updatedAt: new Date(),
      },
    });

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.userId,
    action: enabled ? "job_alert.subscription_enabled" : "job_alert.subscription_disabled",
    targetType: "candidate_account",
    targetId: ctx.candidateAccountId,
    ...meta,
  });

  if (enabled) {
    await sendEvent("job-alert/subscription-updated", {
      candidateAccountId: ctx.candidateAccountId,
    });
  }

  revalidatePath("/roles");
  return { ok: true };
}
