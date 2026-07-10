import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { documents, requests } from "@/db/schema";
import { resolveOrgContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { JD_ALLOWED_TYPES, UPLOAD_MAX_BYTES } from "@/lib/fields";
import { sniffContentType } from "@/lib/scan";
import { newStorageKey, putObjectBytes } from "@/lib/storage";
import { sendEvent } from "@/inngest/client";
import { audit } from "@/lib/audit";

/** Upload (or replace) a request's job description. Accepts PDF or Word (.docx). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "requests:create");
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

    const storageKey = newStorageKey("org", ctx.orgId, jd.name);
    await putObjectBytes(storageKey, bytes, sniffed);
    const [doc] = await db
      .insert(documents)
      .values({
        orgId: ctx.orgId,
        kind: "jd",
        fileName: jd.name,
        contentType: sniffed,
        sizeBytes: jd.size,
        storageKey,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      })
      .returning({ id: documents.id });

    await db.update(requests).set({ jdDocumentId: doc.id }).where(eq(requests.id, id));
    await sendEvent("document/uploaded", { documentId: doc.id, table: "documents" });
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
