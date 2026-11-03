import { NextRequest } from "next/server";
import { handle } from "@/lib/api/http";
import { uploadRequestDocument } from "@/lib/api/request-document-upload";

/** Upload (or replace) a request's non-disclosure agreement; responders must accept it before submitting. Accepts PDF or Word (.docx). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => uploadRequestDocument(req, (await params).id, "nda"));
}
