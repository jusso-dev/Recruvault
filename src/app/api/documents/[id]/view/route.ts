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
import { getObjectStream } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { can } from "@/lib/rbac";

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

  // --- Organisation-side access ---
  try {
    const ctx = await requireOrgUser();
    if (doc.orgId === ctx.orgId) {
      if (can(ctx.role, "documents:view")) {
        authorised = true;
        allowDownload = can(ctx.role, "export:documents");
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
      if (at && at.verifiedAt && at.expiresAt > new Date()) {
        const [request] = await db
          .select()
          .from(requests)
          .where(eq(requests.id, at.requestId));
        if (request && (request.jdDocumentId === doc.id || request.ndaDocumentId === doc.id)) {
          authorised = true;
          allowDownload = request.jdViewMode === "allow_download";
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
          if (own) authorised = true;
        }
      }
    }
  }

  if (!authorised) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  if (wantsDownload && !allowDownload) {
    return NextResponse.json({ error: "Download is not permitted" }, { status: 403 });
  }

  const obj = await getObjectStream(doc.storageKey);
  const disposition = wantsDownload
    ? `attachment; filename="${doc.fileName}"`
    : `inline; filename="${doc.fileName}"`;

  return new NextResponse(obj.body as unknown as ReadableStream, {
    headers: {
      "Content-Type": doc.contentType,
      "Content-Disposition": disposition,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
