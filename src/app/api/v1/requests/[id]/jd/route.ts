import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { documents, requests } from "@/db/schema";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { JD_ALLOWED_TYPES, UPLOAD_MAX_BYTES } from "@/lib/fields";
import { sniffContentType } from "@/lib/scan";
import { enqueueEvent, publishAfterCommit } from "@/lib/outbox";
import { shredDataKey } from "@/lib/crypto";
import { enqueueDeletion } from "@/lib/deletion-queue";
import { activeVault } from "@/lib/vault-store";
import { discardProtectedUploads, protectDocument, putProtectedObject } from "@/lib/document-protect";
import { audit } from "@/lib/audit";
import { AuthError } from "@/lib/guards";

/** Upload (or replace) a request's job description. Accepts PDF or Word (.docx). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "requests:create", "jd:write");
    const { id } = await params;

    const [request] = await db
      .select({ id: requests.id })
      .from(requests)
      .where(and(eq(requests.id, id), eq(requests.orgId, ctx.orgId)));
    if (!request) throw new ApiError(404, "Request not found.");

    const form = await req.formData().catch(() => {
      throw new ApiError(400, "Expected multipart/form-data with a 'jd' file.");
    });
    const jd = form.get("jd");
    if (!(jd instanceof File) || jd.size === 0) throw new ApiError(400, "Missing 'jd' file.");
    if (jd.size > UPLOAD_MAX_BYTES) throw new ApiError(400, "JD exceeds 15 MB.");

    const bytes = Buffer.from(await jd.arrayBuffer());
    const sniffed = sniffContentType(bytes);
    if (!sniffed || !JD_ALLOWED_TYPES.includes(sniffed)) {
      throw new ApiError(400, "The JD must be a PDF or Word (.docx) document.");
    }

    const vault = await activeVault("organisation", ctx.orgId);
    if (!vault) throw new AuthError("Encryption enrollment is required.");
    const prepared = await protectDocument({
      executor: db,
      bytes,
      ownerType: "organisation",
      ownerId: ctx.orgId,
      purpose: "jd",
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
          .select({ jdDocumentId: requests.jdDocumentId })
          .from(requests)
          .where(eq(requests.id, id))
          .for("update");
        const [inserted] = await tx
          .insert(documents)
          .values({
            id: prepared.documentId,
            orgId: ctx.orgId,
            kind: "jd",
            fileName: jd.name,
            contentType: "application/octet-stream",
            originalContentType: sniffed,
            sizeBytes: jd.size,
            storageKey: prepared.storageKey,
            checksum: createHash("sha256").update(bytes).digest("hex"),
            dekId: prepared.dekId,
            envelopeVersion: prepared.envelopeVersion,
            scanStatus: "clean",
          })
          .returning({ id: documents.id });
        await tx.update(requests).set({ jdDocumentId: inserted.id }).where(eq(requests.id, id));
        if (current?.jdDocumentId) {
          const [old] = await tx
            .select()
            .from(documents)
            .where(and(eq(documents.id, current.jdDocumentId), eq(documents.orgId, ctx.orgId)));
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
      action: "request.jd_uploaded",
      targetType: "request",
      targetId: id,
    });

    return json({ documentId: doc.id, contentType: sniffed });
  });
}
