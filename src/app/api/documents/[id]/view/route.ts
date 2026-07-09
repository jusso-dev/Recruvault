import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accessTokens,
  documents,
  requests,
  submissionDocuments,
  submissions,
  submissionShares,
} from "@/db/schema";
import { requireOrgUser, requestMeta, AuthError } from "@/lib/guards";
import { readLinkSession } from "@/lib/link-session";
import { getObjectStream, getObjectBytes } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { watermarkPdf } from "@/lib/watermark";

/**
 * Authorised document streaming. There are no public URLs: every render goes
 * through this route, which checks tenant + role (org side) or the verified
 * link session (responder side), refuses unscanned files, and writes an audit
 * event for every view and download.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wantsDownload = req.nextUrl.searchParams.get("download") === "1";
  const meta = await requestMeta();

  const [doc] = await db.select().from(documents).where(eq(documents.id, id));
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (doc.scanStatus !== "clean") {
    return NextResponse.json(
      { error: "Document is not available (pending scan or quarantined)." },
      { status: 409 },
    );
  }

  let authorised = false;
  let allowDownload = false;
  // Identity burned into the watermark on view-only renders, for traceability.
  let viewerLabel = "";

  // --- Organisation-side access ---
  try {
    const ctx = await requireOrgUser();
    if (doc.orgId === ctx.orgId) {
      if (can(ctx.role, "documents:view")) {
        authorised = true;
        allowDownload = can(ctx.role, "export:documents");
        viewerLabel = ctx.userEmail;
      } else if (ctx.role === "reviewer") {
        // Reviewers see documents only on submissions shared with them.
        const [shared] = await db
          .select({ id: submissionShares.id })
          .from(submissionDocuments)
          .innerJoin(
            submissionShares,
            eq(submissionShares.submissionId, submissionDocuments.submissionId),
          )
          .where(
            and(
              eq(submissionDocuments.documentId, doc.id),
              eq(submissionShares.userId, ctx.userId),
            ),
          );
        authorised = !!shared;
      }
      if (authorised) {
        await audit({
          orgId: ctx.orgId,
          actorType: "org_user",
          actorId: ctx.userId,
          action: wantsDownload ? "document.downloaded" : "document.rendered",
          targetType: "document",
          targetId: doc.id,
          ...meta,
        });
      }
    }
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }

  // --- Link responder access (JD / NDA of the verified request only) ---
  if (!authorised) {
    const accessTokenId = await readLinkSession();
    if (accessTokenId) {
      const [at] = await db
        .select()
        .from(accessTokens)
        .where(eq(accessTokens.id, accessTokenId));
      if (at && at.verifiedAt && !at.revokedAt && at.expiresAt > new Date()) {
        const [request] = await db
          .select()
          .from(requests)
          .where(eq(requests.id, at.requestId));
        const isJd = request?.jdDocumentId === doc.id;
        const isNda = request?.ndaDocumentId === doc.id;
        if (request && (isJd || isNda)) {
          authorised = true;
          viewerLabel = at.recipientEmail;
          // NDA and JD have independent view modes.
          const viewMode = isNda ? request.ndaViewMode : request.jdViewMode;
          allowDownload = viewMode === "allow_download";
          await audit({
            orgId: request.orgId,
            actorType: "link_responder",
            actorId: at.id,
            action: wantsDownload ? "jd.downloaded" : "jd.viewed",
            targetType: "document",
            targetId: doc.id,
            ...meta,
          });
        }
        // A responder may also view their own uploaded evidence before submit.
        if (!authorised) {
          const [own] = await db
            .select({ id: submissionDocuments.id })
            .from(submissionDocuments)
            .innerJoin(submissions, eq(submissions.id, submissionDocuments.submissionId))
            .where(
              and(
                eq(submissionDocuments.documentId, doc.id),
                eq(submissions.accessTokenId, at.id),
              ),
            );
          if (own) {
            authorised = true;
            viewerLabel = at.recipientEmail;
          }
        }
      }
    }
  }

  if (!authorised) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  if (wantsDownload && !allowDownload) {
    return NextResponse.json({ error: "Download is not permitted" }, { status: 403 });
  }

  const commonHeaders = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    // Allow same-origin embedding (the responder/review pages) while blocking
    // cross-origin framing and any active content in the document itself.
    "Content-Security-Policy": "default-src 'none'; object-src 'none'; frame-ancestors 'self'",
  };

  // View-only render: burn a per-viewer watermark into the PDF so the served
  // bytes can't yield a clean copy. A permitted download serves the original
  // (the sanctioned clean copy). Non-PDFs stream as-is.
  const isPdf = doc.contentType === "application/pdf";
  if (!wantsDownload && doc.watermarkRequired && isPdf) {
    const original = await getObjectBytes(doc.storageKey);
    const label = `Recruvault · ${viewerLabel || "authorised viewer"} · ${new Date().toISOString()} · Confidential`;
    const stamped = await watermarkPdf(original, label);
    return new NextResponse(stamped as unknown as BodyInit, {
      headers: {
        ...commonHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${doc.fileName}"`,
      },
    });
  }

  const obj = await getObjectStream(doc.storageKey);
  const disposition = wantsDownload
    ? `attachment; filename="${doc.fileName}"`
    : `inline; filename="${doc.fileName}"`;

  return new NextResponse(obj.body as unknown as ReadableStream, {
    headers: {
      ...commonHeaders,
      "Content-Type": doc.contentType,
      "Content-Disposition": disposition,
    },
  });
}
