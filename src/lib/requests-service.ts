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
import { fieldDefinition, DEFAULT_REQUEST_FIELD_KEYS } from "@/lib/fields";
import { ApiError } from "@/lib/api/http";

/**
 * Shared request logic used by both the dashboard server actions and the REST
 * API, so business rules live in one place.
 */

export interface CreateRequestInput {
  title: string;
  description?: string | null;
  consentPurpose?: string | null;
  listed?: boolean;
  jdViewMode?: "view_only" | "allow_download";
  expiresAt?: Date | null;
  fieldKeys?: string[];
  customLabels?: string[];
  /** Append resume + suitability statement if not already present. */
  includeDefaults?: boolean;
}

export async function createRequestCore(
  ctx: OrgContext,
  input: CreateRequestInput,
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new ApiError(400, "title is required.");

  const keys = new Set([...(input.fieldKeys ?? [])]);
  if (input.includeDefaults !== false) {
    for (const k of DEFAULT_REQUEST_FIELD_KEYS) keys.add(k);
  }
  const customLabels = (input.customLabels ?? []).map((l) => l.trim()).filter(Boolean);
  if (keys.size === 0 && customLabels.length === 0) {
    throw new ApiError(400, "Select at least one field to request.");
  }

  const [request] = await db
    .insert(requests)
    .values({
      orgId: ctx.orgId,
      createdBy: ctx.userId,
      title,
      description: input.description ?? null,
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
  for (const label of customLabels) {
    await db.insert(requestFields).values({
      requestId: request.id,
      key: "custom",
      type: "short_text",
      label,
      required: false,
      sensitive: false,
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
