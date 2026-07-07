"use server";

import { createHash } from "crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  accessTokens,
  consents,
  deliveries,
  documents,
  organisations,
  requestFields,
  requests,
  submissionDocuments,
  submissions,
  submissionValues,
  walletItems,
  walletShares,
} from "@/db/schema";
import {
  createDataKey,
  encryptFieldWithKey,
  generateOtp,
  sha256,
} from "@/lib/crypto";
import { issueLinkSession, readLinkSession, clearLinkSession } from "@/lib/link-session";
import { sendOtpEmail, sendSubmissionReceived } from "@/lib/email";
import { audit } from "@/lib/audit";
import { getSession, requestMeta } from "@/lib/guards";
import { inngest } from "@/inngest/client";
import { newStorageKey, putObjectBytes } from "@/lib/storage";
import { sniffContentType } from "@/lib/scan";
import { UPLOAD_ALLOWED_TYPES, UPLOAD_MAX_BYTES } from "@/lib/fields";
import type { ActionResult } from "./org";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

async function loadToken(rawToken: string) {
  const tokenHash = sha256(rawToken);
  const [at] = await db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, tokenHash));
  return at ?? null;
}

async function orgSender(orgId: string) {
  const [org] = await db.select().from(organisations).where(eq(organisations.id, orgId));
  return {
    orgName: org.name,
    senderName: org.branding?.senderName,
    sendingMode: org.sendingMode,
    sendingDomain: org.sendingDomain,
    sendingDomainVerifiedAt: org.sendingDomainVerifiedAt,
  };
}

/**
 * Step-up verification: issue a one-time code to the address the recruiter
 * specified. An opaque expiring token plus OTP defends against a forwarded
 * link being used by the wrong person.
 */
export async function requestOtp(rawToken: string): Promise<ActionResult> {
  const at = await loadToken(rawToken);
  if (!at) return { ok: false, error: "This link is not valid." };
  if (at.expiresAt < new Date()) return { ok: false, error: "This link has expired." };
  if (at.consumedAt) return { ok: false, error: "This request has already been completed." };

  const { code, codeHash } = generateOtp();
  await db
    .update(accessTokens)
    .set({
      otpHash: codeHash,
      otpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      otpAttempts: 0,
    })
    .where(eq(accessTokens.id, at.id));

  const [req] = await db.select().from(requests).where(eq(requests.id, at.requestId));
  await sendOtpEmail({ to: at.recipientEmail, code, org: await orgSender(req.orgId) });

  const meta = await requestMeta();
  await audit({
    orgId: req.orgId,
    actorType: "link_responder",
    actorId: at.id,
    action: "otp.issued",
    targetType: "access_token",
    targetId: at.id,
    ...meta,
  });

  // Delivery state for the recruiter: link was opened.
  await db
    .update(deliveries)
    .set({ status: "opened", updatedAt: new Date() })
    .where(
      and(eq(deliveries.accessTokenId, at.id), eq(deliveries.status, "sent")),
    );

  return { ok: true };
}

export async function verifyOtp(rawToken: string, code: string): Promise<ActionResult> {
  const at = await loadToken(rawToken);
  if (!at) return { ok: false, error: "This link is not valid." };
  if (at.expiresAt < new Date()) return { ok: false, error: "This link has expired." };
  if (at.consumedAt) return { ok: false, error: "This request has already been completed." };
  if (!at.otpHash || !at.otpExpiresAt || at.otpExpiresAt < new Date()) {
    return { ok: false, error: "The code has expired. Request a new one." };
  }
  if (at.otpAttempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: "Too many attempts. Request a new code." };
  }

  const [req] = await db.select().from(requests).where(eq(requests.id, at.requestId));
  const meta = await requestMeta();

  if (sha256(code.trim()) !== at.otpHash) {
    await db
      .update(accessTokens)
      .set({ otpAttempts: at.otpAttempts + 1 })
      .where(eq(accessTokens.id, at.id));
    await audit({
      orgId: req.orgId,
      actorType: "link_responder",
      actorId: at.id,
      action: "otp.failed",
      targetType: "access_token",
      targetId: at.id,
      ...meta,
    });
    return { ok: false, error: "That code is not correct." };
  }

  await db
    .update(accessTokens)
    .set({ verifiedAt: new Date(), otpHash: null })
    .where(eq(accessTokens.id, at.id));
  await issueLinkSession(at.id);

  await audit({
    orgId: req.orgId,
    actorType: "link_responder",
    actorId: at.id,
    action: "otp.verified",
    targetType: "access_token",
    targetId: at.id,
    ...meta,
  });

  return { ok: true };
}

/**
 * Submit a response: consent gate, encrypted structured values (one DEK per
 * submission), controlled uploads, wallet share recording, and audit.
 */
export async function submitResponse(formData: FormData): Promise<ActionResult> {
  const accessTokenId = await readLinkSession();
  if (!accessTokenId) return { ok: false, error: "Your session has expired. Reopen the link." };

  const [at] = await db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.id, accessTokenId));
  if (!at || !at.verifiedAt) return { ok: false, error: "Verification required." };
  if (at.consumedAt) return { ok: false, error: "This request has already been completed." };
  if (at.expiresAt < new Date()) return { ok: false, error: "This link has expired." };

  const [request] = await db.select().from(requests).where(eq(requests.id, at.requestId));
  if (!request || request.status === "closed" || request.status === "archived") {
    return { ok: false, error: "This role is closed." };
  }

  if (request.consentRequired && formData.get("consent") !== "on") {
    return { ok: false, error: "You must accept the collection notice to continue." };
  }
  if (request.ndaDocumentId && formData.get("nda") !== "on") {
    return { ok: false, error: "You must accept the NDA to continue." };
  }

  const fields = await db
    .select()
    .from(requestFields)
    .where(eq(requestFields.requestId, request.id))
    .orderBy(requestFields.sortOrder);

  // Validate before writing anything.
  for (const f of fields) {
    if (!f.required) continue;
    if (f.type === "file_upload") {
      const file = formData.get(`field_${f.id}`);
      if (!(file instanceof File) || file.size === 0) {
        return { ok: false, error: `"${f.label}" requires an upload.` };
      }
    } else {
      const v = String(formData.get(`field_${f.id}`) ?? "").trim();
      if (!v) return { ok: false, error: `"${f.label}" is required.` };
      if (f.type === "date" && Number.isNaN(new Date(v).getTime())) {
        return { ok: false, error: `"${f.label}" must be a valid date.` };
      }
    }
  }

  // If the responder is a signed-in job seeker, link the submission to their
  // account so it appears in their history and the consent ledger.
  let candidateAccountId: string | null = null;
  const session = await getSession();
  if (session && (session.user as { accountType?: string }).accountType !== "org") {
    const { requireCandidate } = await import("@/lib/guards");
    candidateAccountId = (await requireCandidate()).candidateAccountId;
  }

  const meta = await requestMeta();

  const [submission] = await db
    .insert(submissions)
    .values({
      requestId: request.id,
      candidateAccountId,
      accessTokenId: at.id,
      responderEmail: at.recipientEmail,
      status: "received",
      submittedAt: new Date(),
    })
    .returning({ id: submissions.id });

  // One DEK per submission: shredding it renders every field unrecoverable.
  const { dekId, dek } = await createDataKey();

  for (const f of fields) {
    if (f.type === "file_upload") {
      const file = formData.get(`field_${f.id}`);
      if (!(file instanceof File) || file.size === 0) continue;
      if (file.size > UPLOAD_MAX_BYTES) {
        return { ok: false, error: `"${f.label}" exceeds the 15 MB limit.` };
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const sniffed = sniffContentType(bytes);
      if (!sniffed || !UPLOAD_ALLOWED_TYPES.includes(sniffed)) {
        return { ok: false, error: `"${f.label}" must be a PDF or an image.` };
      }
      const storageKey = newStorageKey("org", request.orgId, file.name);
      await putObjectBytes(storageKey, bytes, sniffed);
      const [doc] = await db
        .insert(documents)
        .values({
          orgId: request.orgId,
          kind: "evidence",
          fileName: file.name,
          contentType: sniffed,
          sizeBytes: file.size,
          storageKey,
          checksum: createHash("sha256").update(bytes).digest("hex"),
        })
        .returning({ id: documents.id });
      await db.insert(submissionDocuments).values({
        submissionId: submission.id,
        fieldId: f.id,
        documentId: doc.id,
      });
      await inngest.send({
        name: "document/uploaded",
        data: { documentId: doc.id, table: "documents" },
      });
    } else {
      const raw = String(formData.get(`field_${f.id}`) ?? "").trim();
      if (!raw) continue;
      await db.insert(submissionValues).values({
        submissionId: submission.id,
        fieldId: f.id,
        valueEncrypted: await encryptFieldWithKey(raw, dek),
        dekId,
      });
    }
  }

  // Consent records: versioned, timestamped, with IP.
  if (request.consentRequired) {
    await db.insert(consents).values({
      submissionId: submission.id,
      type: "collection",
      noticeVersion: request.consentNoticeVersion,
      ip: meta.ip,
    });
  }
  if (request.ndaDocumentId) {
    await db.insert(consents).values({
      submissionId: submission.id,
      type: "nda",
      noticeVersion: request.consentNoticeVersion,
      ip: meta.ip,
    });
  }

  // Consent ledger: record wallet items used to pre-fill this submission.
  if (candidateAccountId) {
    const usedItemIds = formData.getAll("walletItemsUsed").map(String).filter(Boolean);
    if (usedItemIds.length > 0) {
      const owned = await db
        .select({ id: walletItems.id })
        .from(walletItems)
        .where(
          and(
            eq(walletItems.candidateAccountId, candidateAccountId),
            inArray(walletItems.id, usedItemIds),
          ),
        );
      for (const item of owned) {
        await db.insert(walletShares).values({
          candidateAccountId,
          submissionId: submission.id,
          walletItemId: item.id,
          orgId: request.orgId,
        });
      }
    }
  }

  await db
    .update(accessTokens)
    .set({ consumedAt: new Date() })
    .where(eq(accessTokens.id, at.id));
  await db
    .update(deliveries)
    .set({ status: "submitted", updatedAt: new Date() })
    .where(eq(deliveries.accessTokenId, at.id));

  await audit({
    orgId: request.orgId,
    actorType: candidateAccountId ? "candidate" : "link_responder",
    actorId: candidateAccountId ?? at.id,
    action: "submission.created",
    targetType: "submission",
    targetId: submission.id,
    ...meta,
  });

  const [org] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, request.orgId));
  await sendSubmissionReceived({
    to: at.recipientEmail,
    org: await orgSender(request.orgId),
    requestTitle: request.title,
    retentionDays: org.retentionDays,
  });
  await inngest.send({
    name: "submission/received",
    data: { submissionId: submission.id },
  });

  await clearLinkSession();
  return { ok: true, id: submission.id };
}
