import "server-only";
import type { NextRequest } from "next/server";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { documents, requests } from "@/db/schema";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, json } from "@/lib/api/http";
import { JD_ALLOWED_TYPES, UPLOAD_MAX_BYTES } from "@/lib/fields";
import { sniffContentType } from "@/lib/scan";
import { enqueueEvent, publishAfterCommit } from "@/lib/outbox";
import { shredDataKey } from "@/lib/crypto";
import { enqueueDeletion } from "@/lib/deletion-queue";
import { activeVault } from "@/lib/vault-store";
import { discardProtectedUploads, protectDocument, putProtectedObject } from "@/lib/document-protect";
import { audit } from "@/lib/audit";
import { AuthError } from "@/lib/guards";
import { canManageRequest } from "@/lib/review";

const KINDS = {
  jd: { label: "JD", column: "jdDocumentId", audit: "request.jd_uploaded" },
  nda: { label: "NDA", column: "ndaDocumentId", audit: "request.nda_uploaded" },
} as const;

/**
 * Upload (or replace) a request's job description or NDA. Accepts PDF or
 * Word (.docx). The multipart field name matches the kind.
 */
export async function uploadRequestDocument(req: NextRequest, id: string, kind: keyof typeof KINDS) {
  const { label, column, audit: auditAction } = KINDS[kind];
  const ctx = await resolveOrgContext(req, "requests:create", "jd:write");

  const [request] = await db
    .select({ id: requests.id, createdBy: requests.createdBy })
    .from(requests)
    .where(and(eq(requests.id, id), eq(requests.orgId, ctx.orgId)));
  if (!request || !canManageRequest(ctx, request)) throw new ApiError(404, "Request not found.");

  const form = await req.formData().catch(() => {
    throw new ApiError(400, `Expected multipart/form-data with a '${kind}' file.`);
  });
  const file = form.get(kind);
  if (!(file instanceof File) || file.size === 0) throw new ApiError(400, `Missing '${kind}' file.`);
  if (file.size > UPLOAD_MAX_BYTES) throw new ApiError(400, `${label} exceeds 15 MB.`);

  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffContentType(bytes);
  if (!sniffed || !JD_ALLOWED_TYPES.includes(sniffed)) {
    throw new ApiError(400, `The ${label} must be a PDF or Word (.docx) document.`);
  }

  const vault = await activeVault("organisation", ctx.orgId);
  if (!vault) throw new AuthError("Encryption enrollment is required.");
  const prepared = await protectDocument({
    executor: db,
    bytes,
    ownerType: "organisation",
    ownerId: ctx.orgId,
    purpose: kind,
    keyVersion: vault.version,
    recipientPublicKey: vault.publicKey,
    scope: "org",
  });
  if (!prepared.ok) throw new ApiError(400, prepared.error);

  // The new document, the pointer switch, and retirement of the replaced JD
  // commit together. The replaced JD's key is shredded and its object queued
  // for durable deletion in the same transaction.
  let doc: { id: string };
  try {
    await putProtectedObject(prepared.storageKey, prepared.ciphertext);
    doc = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ current: requests[column] })
        .from(requests)
        .where(eq(requests.id, id))
        .for("update");
      const [inserted] = await tx
        .insert(documents)
        .values({
          id: prepared.documentId,
          orgId: ctx.orgId,
          kind,
          fileName: file.name,
          contentType: "application/octet-stream",
          originalContentType: sniffed,
          sizeBytes: file.size,
          storageKey: prepared.storageKey,
          checksum: createHash("sha256").update(bytes).digest("hex"),
          dekId: prepared.dekId,
          envelopeVersion: prepared.envelopeVersion,
          scanStatus: "clean",
        })
        .returning({ id: documents.id });
      await tx.update(requests).set({ [column]: inserted.id }).where(eq(requests.id, id));
      if (current?.current) {
        const [old] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, current.current), eq(documents.orgId, ctx.orgId)));
        if (old) {
          if (old.dekId) await shredDataKey(old.dekId, tx);
          await enqueueDeletion(tx, old.storageKey, ctx.orgId);
          await tx.delete(documents).where(eq(documents.id, old.id));
        }
      }
      await enqueueEvent(
        tx,
        "document/uploaded",
        { documentId: inserted.id, table: "documents" },
        `document/uploaded:documents:${inserted.id}`,
        ctx.orgId,
      );
      return inserted;
    });
  } catch (err) {
    await discardProtectedUploads(
      [{ storageKey: prepared.storageKey, dekId: prepared.dekId }],
      ctx.orgId,
    );
    throw err;
  }
  await publishAfterCommit();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: auditAction,
    targetType: "request",
    targetId: id,
  });

  return json({ documentId: doc.id, contentType: sniffed });
}
