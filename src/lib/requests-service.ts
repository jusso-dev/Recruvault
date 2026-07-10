import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  candidateAccounts,
  discoveryProfiles,
  requestFields,
  requests,
  suppressions,
  user,
} from "@/db/schema";
import type { OrgContext } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { sendEvent } from "@/inngest/client";
import {
  fieldDefinition,
  DEFAULT_REQUEST_FIELD_KEYS,
  ROLE_REQUEST_FIELD_KEYS,
} from "@/lib/fields";
import { ApiError } from "@/lib/api/http";
import {
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  WORK_ARRANGEMENTS,
} from "@/lib/role-metadata";

/**
 * Shared request logic used by both the dashboard server actions and the REST
 * API, so business rules live in one place.
 */

export interface CreateRequestInput {
  title: string;
  description?: string | null;
  location?: string | null;
  employmentType?: string | null;
  workArrangement?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryPeriod?: string | null;
  skills?: string[];
  consentPurpose?: string | null;
  listed?: boolean;
  jdViewMode?: "view_only" | "allow_download";
  expiresAt?: Date | null;
  fieldKeys?: string[];
  /** Append resume + cover letter/suitability statement if not already present. */
  includeDefaults?: boolean;
}

export async function createRequestCore(
  ctx: OrgContext,
  input: CreateRequestInput,
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new ApiError(400, "title is required.");
  if (
    input.employmentType &&
    !EMPLOYMENT_TYPES.includes(input.employmentType as (typeof EMPLOYMENT_TYPES)[number])
  ) {
    throw new ApiError(400, "Unsupported employmentType.");
  }
  if (
    input.workArrangement &&
    !WORK_ARRANGEMENTS.includes(input.workArrangement as (typeof WORK_ARRANGEMENTS)[number])
  ) {
    throw new ApiError(400, "Unsupported workArrangement.");
  }
  if (
    input.salaryPeriod &&
    !SALARY_PERIODS.includes(input.salaryPeriod as (typeof SALARY_PERIODS)[number])
  ) {
    throw new ApiError(400, "Unsupported salaryPeriod.");
  }
  if (
    (input.salaryMin != null && (!Number.isInteger(input.salaryMin) || input.salaryMin < 0)) ||
    (input.salaryMax != null && (!Number.isInteger(input.salaryMax) || input.salaryMax < 0)) ||
    (input.salaryMin != null && input.salaryMax != null && input.salaryMin > input.salaryMax)
  ) {
    throw new ApiError(400, "Invalid salary or rate range.");
  }

  const keys = new Set([...(input.fieldKeys ?? [])]);
  const skills = [...new Set((input.skills ?? []).map((skill) => skill.trim()).filter(Boolean))]
    .slice(0, 30);
  if (skills.some((skill) => skill.length > 80)) {
    throw new ApiError(400, "Each skill or keyword must be 80 characters or fewer.");
  }
  if (input.includeDefaults !== false) {
    for (const k of DEFAULT_REQUEST_FIELD_KEYS) keys.add(k);
  }
  const invalidKey = [...keys].find(
    (key) => !ROLE_REQUEST_FIELD_KEYS.includes(key as (typeof ROLE_REQUEST_FIELD_KEYS)[number]),
  );
  if (invalidKey) {
    throw new ApiError(
      400,
      "Roles may only request clearance level, clearance ID, resume, and cover letter/suitability statement.",
    );
  }
  if (keys.size === 0) {
    throw new ApiError(400, "Select at least one field to request.");
  }

  const [request] = await db
    .insert(requests)
    .values({
      orgId: ctx.orgId,
      createdBy: ctx.userId,
      title,
      description: input.description ?? null,
      location: input.location ?? null,
      employmentType: input.employmentType ?? null,
      workArrangement: input.workArrangement ?? null,
      salaryMin: input.salaryMin ?? null,
      salaryMax: input.salaryMax ?? null,
      salaryPeriod: input.salaryPeriod ?? null,
      skills,
      status: "open",
      listed: input.listed ?? false,
      expiresAt: input.expiresAt ?? null,
      consentRequired: true,
      consentPurpose: input.consentPurpose ?? null,
      jdViewMode: input.jdViewMode ?? "view_only",
    })
    .returning({ id: requests.id });

  let sortOrder = 0;
  for (const key of keys) {
    const def = fieldDefinition(key);
    if (!def) continue;
    await db.insert(requestFields).values({
      requestId: request.id,
      key: def.key,
      type: def.type,
      label: def.label,
      helpText: def.helpText,
      required: true,
      sensitive: def.sensitive,
      sortOrder: sortOrder++,
    });
  }
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "request.created",
    targetType: "request",
    targetId: request.id,
  });

  if ((input.listed ?? false) && skills.length > 0) {
    await sendEvent("job-alert/role-listed", { requestId: request.id });
  }

  return request.id;
}

/**
 * Send a request's secure link to an email address or to a matched candidate
 * (by opaque discovery handle, resolved to their email server-side so the
 * caller never sees it).
 */
export async function sendRequestCore(
  ctx: OrgContext,
  requestId: string,
  target: { email?: string; candidateHandle?: string },
): Promise<void> {
  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.orgId, ctx.orgId)));
  if (!request) throw new ApiError(404, "Request not found.");
  if (request.status !== "open" && request.status !== "closing_soon") {
    throw new ApiError(409, "Only open requests can be sent.");
  }
  if (request.expiresAt && request.expiresAt < new Date()) {
    throw new ApiError(409, "This request has expired. Update the expiry first.");
  }

  let email = target.email?.trim().toLowerCase();
  if (!email && target.candidateHandle) {
    const [row] = await db
      .select({ email: user.email })
      .from(discoveryProfiles)
      .innerJoin(
        candidateAccounts,
        eq(candidateAccounts.id, discoveryProfiles.candidateAccountId),
      )
      .innerJoin(user, eq(user.id, candidateAccounts.userId))
      .where(
        and(
          eq(discoveryProfiles.handle, target.candidateHandle),
          eq(discoveryProfiles.discoverable, true),
        ),
      );
    if (!row) throw new ApiError(404, "No discoverable candidate for that handle.");
    email = row.email.toLowerCase();
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ApiError(400, "A valid recipient email or candidateHandle is required.");
  }

  const [suppressed] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, email));
  if (suppressed) throw new ApiError(409, "That address is suppressed (previously bounced).");

  await sendEvent("request/send", { requestId, recipientEmail: email, sentBy: ctx.userId });
}
