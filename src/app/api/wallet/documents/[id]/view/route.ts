import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { walletDocuments } from "@/db/schema";
import { requireCandidate, requestMeta, AuthError } from "@/lib/guards";
import { getObjectStream } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { CAREER_DOCUMENT_KINDS } from "@/lib/fields";

/** Wallet documents are visible only to their owner. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireCandidate();
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "Not authorised" }, { status: 403 });
    }
    throw err;
  }

  const [doc] = await db.select().from(walletDocuments).where(eq(walletDocuments.id, id));
  if (!doc || doc.candidateAccountId !== ctx.candidateAccountId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!CAREER_DOCUMENT_KINDS.has(doc.kind)) {
    return NextResponse.json({ error: "That document type is no longer supported." }, { status: 410 });
  }
  if (doc.scanStatus !== "clean") {
    return NextResponse.json({ error: "Document is not available." }, { status: 409 });
  }

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "wallet_document.rendered",
    targetType: "wallet_document",
    targetId: doc.id,
    ...meta,
  });

  const obj = await getObjectStream(doc.storageKey);
  return new NextResponse(obj.body as unknown as ReadableStream, {
    headers: {
      "Content-Type": doc.contentType,
      "Content-Disposition": `inline; filename="${doc.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; object-src 'none'; frame-ancestors 'self'",
    },
  });
}
