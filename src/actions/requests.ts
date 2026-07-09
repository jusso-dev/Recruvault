"use server";

import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  documents,
  memberships,
  requestFields,
  requests,
  requestTemplates,
  submissionShares,
  submissions,
  suppressions,
} from "@/db/schema";
import { requireOrgUser, requestMeta } from "@/lib/guards";
import { audit } from "@/lib/audit";
import { inngest } from "@/inngest/client";
import { newStorageKey, putObjectBytes } from "@/lib/storage";
import {
  fieldDefinition,
  UPLOAD_ALLOWED_TYPES,
  UPLOAD_MAX_BYTES,
} from "@/lib/fields";
import { sniffContentType } from "@/lib/scan";
import type { ActionResult } from "./org";

/**
 * Create a request: JD attachment, requested-field set from the field
 * library plus custom fields, delivery and expiry settings, consent gate,
 * and listed/private visibility.
 */
export async function createRequest(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("requests:create");
  const meta = await requestMeta();

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };
  const description = String(formData.get("description") ?? "").trim() || null;
  const consentPurpose = String(formData.get("consentPurpose") ?? "").trim() || null;
  const listed = formData.get("listed") === "on";
  const jdViewMode =
    formData.get("jdViewMode") === "allow_download" ? "allow_download" : "view_only";
  const expiresAtRaw = String(formData.get("expiresAt") ?? "");
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return { ok: false, error: "Invalid expiry date." };
  }

  const libraryKeys = formData.getAll("fields").map(String);
  const customLabels = String(formData.get("customFields") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (libraryKeys.length === 0 && customLabels.length === 0) {
    return { ok: false, error: "Select at least one field to request." };
  }

  // Optional JD upload, stored encrypted and scanned before it can be viewed.
  let jdDocumentId: string | null = null;
  const jd = formData.get("jd");
  if (jd instanceof File && jd.size > 0) {
    if (jd.size > UPLOAD_MAX_BYTES) return { ok: false, error: "JD exceeds 15 MB." };
    const bytes = Buffer.from(await jd.arrayBuffer());
    const sniffed = sniffContentType(bytes);
    if (sniffed !== "application/pdf") {
      return { ok: false, error: "The JD must be a PDF." };
    }
    const storageKey = newStorageKey("org", ctx.orgId, jd.name);
    await putObjectBytes(storageKey, bytes, "application/pdf");
    const [doc] = await db
      .insert(documents)
      .values({
        orgId: ctx.orgId,
        kind: "jd",
        fileName: jd.name,
        contentType: "application/pdf",
        sizeBytes: jd.size,
        storageKey,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      })
      .returning({ id: documents.id });
    jdDocumentId = doc.id;
    await inngest.send({
      name: "document/uploaded",
      data: { documentId: doc.id, table: "documents" },
    });
  }

  const [request] = await db
    .insert(requests)
    .values({
      orgId: ctx.orgId,
      createdBy: ctx.userId,
      title,
      description,
      status: "open",
      listed,
      expiresAt,
      consentRequired: true,
      consentPurpose,
      jdDocumentId,
      jdViewMode,
    })
    .returning({ id: requests.id });

  let sortOrder = 0;
  for (const key of libraryKeys) {
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

  if (formData.get("saveAsTemplate") === "on") {
    await db.insert(requestTemplates).values({
      orgId: ctx.orgId,
      name: title,
      createdBy: ctx.userId,
      definition: { title, description, libraryKeys, customLabels, jdViewMode },
    });
  }

  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "request.created",
    targetType: "request",
    targetId: request.id,
    ...meta,
  });

  revalidatePath("/dashboard");
  return { ok: true, id: request.id };
}

/** Queue delivery of a secure link by email (and optionally SMS). */
export async function sendRequest(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("requests:create");
  const requestId = String(formData.get("requestId") ?? "");
  const recipientEmail = String(formData.get("recipientEmail") ?? "").trim().toLowerCase();
  const recipientPhone = String(formData.get("recipientPhone") ?? "").trim() || undefined;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) {
    return { ok: false, error: "A valid recipient email is required." };
  }

  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.orgId, ctx.orgId)));
  if (!request) return { ok: false, error: "Request not found." };
  if (request.status !== "open" && request.status !== "closing_soon") {
    return { ok: false, error: "Only open requests can be sent." };
  }
  if (request.expiresAt && request.expiresAt < new Date()) {
    return { ok: false, error: "This request has expired. Update the expiry first." };
  }

  const [suppressed] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, recipientEmail));
  if (suppressed) {
    return {
      ok: false,
      error: "That address previously hard-bounced and is suppressed.",
    };
  }

  await inngest.send({
    name: "request/send",
    data: { requestId, recipientEmail, recipientPhone, sentBy: ctx.userId },
  });

  revalidatePath(`/dashboard/requests/${requestId}`);
  return { ok: true };
}

export async function setRequestStatus(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("requests:create");
  const requestId = String(formData.get("requestId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["open", "closing_soon", "closed", "archived"].includes(status)) {
    return { ok: false, error: "Invalid status." };
  }

  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.orgId, ctx.orgId)));
  if (!request) return { ok: false, error: "Request not found." };

  await db
    .update(requests)
    .set({
      status: status as "open" | "closing_soon" | "closed" | "archived",
      closedAt: status === "closed" ? new Date() : request.closedAt,
    })
    .where(eq(requests.id, requestId));

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: `request.status.${status}`,
    targetType: "request",
    targetId: requestId,
    ...meta,
  });

  revalidatePath(`/dashboard/requests/${requestId}`);
  return { ok: true };
}

/** Share a submission with a reviewer (read-only, shared-only access). */
export async function shareSubmission(formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgUser("requests:create");
  const submissionId = String(formData.get("submissionId") ?? "");
  const userId = String(formData.get("userId") ?? "");

  const [sub] = await db
    .select({ id: submissions.id, orgId: requests.orgId })
    .from(submissions)
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .where(and(eq(submissions.id, submissionId), eq(requests.orgId, ctx.orgId)));
  if (!sub) return { ok: false, error: "Submission not found." };

  const [member] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId)));
  if (!member) return { ok: false, error: "That user is not a member of your organisation." };

  await db
    .insert(submissionShares)
    .values({ submissionId, userId })
    .onConflictDoNothing();

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: "submission.shared",
    targetType: "submission",
    targetId: submissionId,
    ...meta,
  });

  revalidatePath(`/dashboard`);
  return { ok: true };
}
