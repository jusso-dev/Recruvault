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
  constantTimeEqualHex,
  createDataKey,
  encryptFieldWithKey,
  generateOtp,
  sha256,
} from "@/lib/crypto";
import { issueLinkSession, readLinkSession, clearLinkSession } from "@/lib/link-session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getLogger } from "@/lib/logger";
import { sendOtpEmail, sendSubmissionReceived } from "@/lib/email";
import { audit } from "@/lib/audit";
import { getSession, requestMeta } from "@/lib/guards";
import { sendEvent } from "@/inngest/client";
import { newStorageKey, putObjectBytes, deleteObject } from "@/lib/storage";
import { sniffContentType } from "@/lib/scan";
import { allowedTypesForField, UPLOAD_MAX_BYTES } from "@/lib/fields";
import type { ActionResult } from "./org";

const log = getLogger("link");

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
// Resend throttling. A fresh code resets the per-code attempt counter, so we
// must also bound how many codes can be issued: at most OTP_MAX_RESENDS per
// window, no more often than every OTP_MIN_RESEND_INTERVAL_MS. Caps total
// guesses to ~OTP_MAX_RESENDS * OTP_MAX_ATTEMPTS against a 10^6 space.
const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_RESENDS = 5;
const OTP_MIN_RESEND_INTERVAL_MS = 30 * 1000;

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
  const meta = await requestMeta();
  // IP-level throttle across all tokens (complements the per-token resend cap).
  if (!(await checkRateLimit(`otp:request:${meta.ip ?? "unknown"}`, 10, 60_000))) {
    return { ok: false, error: "Too many requests. Please try again shortly." };
  }

  const at = await loadToken(rawToken);
  if (!at) return { ok: false, error: "This link is not valid." };
  if (at.expiresAt < new Date()) return { ok: false, error: "This link has expired." };
  if (at.revokedAt) return { ok: false, error: "This link has been revoked by the sender." };
  if (at.consumedAt) return { ok: false, error: "This request has already been completed." };

  const now = new Date();
  // Minimum interval between codes.
  if (at.otpLastSentAt && now.getTime() - at.otpLastSentAt.getTime() < OTP_MIN_RESEND_INTERVAL_MS) {
    return { ok: false, error: "Please wait a moment before requesting another code." };
  }
  // Rolling resend window.
  const windowActive =
    at.otpWindowStart && now.getTime() - at.otpWindowStart.getTime() < OTP_RESEND_WINDOW_MS;
  const resends = windowActive ? at.otpResends : 0;
  if (resends >= OTP_MAX_RESENDS) {
    return { ok: false, error: "Too many code requests. Please try again later." };
  }

  const { code, codeHash } = generateOtp();
  await db
    .update(accessTokens)
    .set({
      otpHash: codeHash,
      otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
      otpAttempts: 0,
      otpResends: resends + 1,
      otpWindowStart: windowActive ? at.otpWindowStart : now,
      otpLastSentAt: now,
    })
    .where(eq(accessTokens.id, at.id));

  const [req] = await db.select().from(requests).where(eq(requests.id, at.requestId));
  await sendOtpEmail({ to: at.recipientEmail, code, org: await orgSender(req.orgId) });

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
  const meta = await requestMeta();
  if (!(await checkRateLimit(`otp:verify:${meta.ip ?? "unknown"}`, 15, 60_000))) {
    return { ok: false, error: "Too many attempts. Please try again shortly." };
  }

  const at = await loadToken(rawToken);
  if (!at) return { ok: false, error: "This link is not valid." };
  if (at.expiresAt < new Date()) return { ok: false, error: "This link has expired." };
  if (at.revokedAt) return { ok: false, error: "This link has been revoked by the sender." };
  if (at.consumedAt) return { ok: false, error: "This request has already been completed." };
  if (!at.otpHash || !at.otpExpiresAt || at.otpExpiresAt < new Date()) {
    return { ok: false, error: "The code has expired. Request a new one." };
  }
  if (at.otpAttempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: "Too many attempts. Request a new code." };
  }

  const [req] = await db.select().from(requests).where(eq(requests.id, at.requestId));

  if (!constantTimeEqualHex(sha256(code.trim()), at.otpHash)) {
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
  if (at.revokedAt) return { ok: false, error: "This link has been revoked by the sender." };
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

  // --- Phase 1: validate everything up front. No writes yet. ---
  const preparedUploads: {
    fieldId: string;
    bytes: Buffer;
    contentType: string;
    fileName: string;
    size: number;
    checksum: string;
    storageKey: string;
  }[] = [];
  const preparedValues: { fieldId: string; raw: string }[] = [];

  for (const f of fields) {
    if (f.type === "file_upload") {
      const file = formData.get(`field_${f.id}`);
      if (!(file instanceof File) || file.size === 0) {
        if (f.required) return { ok: false, error: `"${f.label}" requires an upload.` };
        continue;
      }
      if (file.size > UPLOAD_MAX_BYTES) {
        return { ok: false, error: `"${f.label}" exceeds the 15 MB limit.` };
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const sniffed = sniffContentType(bytes);
      const allowed = allowedTypesForField(f.key);
      if (!sniffed || !allowed.includes(sniffed)) {
        const hint = f.key === "resume" ? "a PDF or Word document" : "a PDF or an image";
        return { ok: false, error: `"${f.label}" must be ${hint}.` };
      }
      preparedUploads.push({
        fieldId: f.id,
        bytes,
        contentType: sniffed,
        fileName: file.name,
        size: file.size,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        storageKey: newStorageKey("org", request.orgId, file.name),
      });
    } else {
      const raw = String(formData.get(`field_${f.id}`) ?? "").trim();
      if (!raw) {
        if (f.required) return { ok: false, error: `"${f.label}" is required.` };
        continue;
      }
      if (f.type === "date" && Number.isNaN(new Date(raw).getTime())) {
        return { ok: false, error: `"${f.label}" must be a valid date.` };
      }
      preparedValues.push({ fieldId: f.id, raw });
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

  // Wallet items the seeker chose to share (validated against ownership).
  let sharedWalletItemIds: string[] = [];
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
      sharedWalletItemIds = owned.map((o) => o.id);
    }
  }

  // --- Phase 2: upload objects to S3 (external, pre-transaction). ---
  const uploadedKeys: string[] = [];
  try {
    for (const u of preparedUploads) {
      await putObjectBytes(u.storageKey, u.bytes, u.contentType);
      uploadedKeys.push(u.storageKey);
    }

    // --- Phase 3: one transaction — either the whole submission lands or none. ---
    const result = await db.transaction(async (tx) => {
      // Consume the token first, with a race guard so a double-submit can't
      // create two submissions.
      const consumed = await tx
        .update(accessTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(accessTokens.id, at.id), isNull(accessTokens.consumedAt)))
        .returning({ id: accessTokens.id });
      if (consumed.length === 0) return { alreadyDone: true as const };

      const [submission] = await tx
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
      const { dekId, dek } = await createDataKey(tx);

      if (preparedValues.length > 0) {
        const rows = await Promise.all(
          preparedValues.map(async (v) => ({
            submissionId: submission.id,
            fieldId: v.fieldId,
            valueEncrypted: await encryptFieldWithKey(v.raw, dek),
            dekId,
          })),
        );
        await tx.insert(submissionValues).values(rows);
      }

      const documentIds: string[] = [];
      for (const u of preparedUploads) {
        const [doc] = await tx
          .insert(documents)
          .values({
            orgId: request.orgId,
            kind: "evidence",
            fileName: u.fileName,
            contentType: u.contentType,
            sizeBytes: u.size,
            storageKey: u.storageKey,
            checksum: u.checksum,
          })
          .returning({ id: documents.id });
        await tx.insert(submissionDocuments).values({
          submissionId: submission.id,
          fieldId: u.fieldId,
          documentId: doc.id,
        });
        documentIds.push(doc.id);
      }

      // Consent records: versioned, timestamped, with IP.
      if (request.consentRequired) {
        await tx.insert(consents).values({
          submissionId: submission.id,
          type: "collection",
          noticeVersion: request.consentNoticeVersion,
          ip: meta.ip,
        });
      }
      if (request.ndaDocumentId) {
        await tx.insert(consents).values({
          submissionId: submission.id,
          type: "nda",
          noticeVersion: request.consentNoticeVersion,
          ip: meta.ip,
        });
      }

      // Consent ledger: wallet items used to pre-fill this submission.
      if (candidateAccountId && sharedWalletItemIds.length > 0) {
        await tx.insert(walletShares).values(
          sharedWalletItemIds.map((walletItemId) => ({
            candidateAccountId,
            submissionId: submission.id,
            walletItemId,
            orgId: request.orgId,
          })),
        );
      }

      await tx
        .update(deliveries)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(eq(deliveries.accessTokenId, at.id));

      return { alreadyDone: false as const, submissionId: submission.id, documentIds };
    });

    if (result.alreadyDone) {
      // Objects were uploaded for a submission that another request already
      // completed; clean them up.
      await cleanupObjects(uploadedKeys);
      return { ok: false, error: "This request has already been completed." };
    }

    // --- Phase 4: after commit — side effects that must not roll back writes. ---
    await audit({
      orgId: request.orgId,
      actorType: candidateAccountId ? "candidate" : "link_responder",
      actorId: candidateAccountId ?? at.id,
      action: "submission.created",
      targetType: "submission",
      targetId: result.submissionId,
      ...meta,
    });

    for (const documentId of result.documentIds) {
      await sendEvent("document/uploaded", { documentId, table: "documents" });
    }
    await sendEvent("submission/received", { submissionId: result.submissionId });

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

    await clearLinkSession();
    return { ok: true, id: result.submissionId };
  } catch (err) {
    // Compensation: the transaction rolled back, so remove any uploaded objects.
    await cleanupObjects(uploadedKeys);
    log.error({ err, accessTokenId: at.id }, "submitResponse failed");
    return { ok: false, error: "Something went wrong saving your response. Please try again." };
  }
}

async function cleanupObjects(keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await deleteObject(key);
    } catch (err) {
      log.error({ key, err }, "failed to clean up uploaded object");
    }
  }
}
