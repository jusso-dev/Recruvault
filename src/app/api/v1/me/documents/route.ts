import { NextRequest } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { walletDocuments } from "@/db/schema";
import { resolveCandidateContext } from "@/lib/api-auth";
import { handle, json } from "@/lib/api/http";
import { WALLET_DOCUMENT_TYPES } from "@/lib/fields";

/** List career-document metadata. File contents remain behind audited browser routes. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await resolveCandidateContext(req);
    const allowedKinds = WALLET_DOCUMENT_TYPES.map((type) => type.type);
    const rows = await db
      .select({
        id: walletDocuments.id,
        kind: walletDocuments.kind,
        fileName: walletDocuments.fileName,
        contentType: walletDocuments.contentType,
        scanStatus: walletDocuments.scanStatus,
        createdAt: walletDocuments.createdAt,
      })
      .from(walletDocuments)
      .where(
        and(
          eq(walletDocuments.candidateAccountId, ctx.candidateAccountId),
          inArray(walletDocuments.kind, allowedKinds),
        ),
      )
      .orderBy(desc(walletDocuments.createdAt));

    return json({ documents: rows });
  });
}
