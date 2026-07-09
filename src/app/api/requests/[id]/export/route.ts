import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { requestFields, requests, submissions, submissionValues } from "@/db/schema";
import { requireOrgUser, requestMeta, AuthError } from "@/lib/guards";
import { createDekCache, decryptFieldWithKey } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { can } from "@/lib/rbac";

/**
 * Export structured submission data as CSV or JSON. A controlled, logged
 * action gated by role. Document export is separate and further gated.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireOrgUser("export:data");
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const format = req.nextUrl.searchParams.get("format") === "json" ? "json" : "csv";

  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), eq(requests.orgId, ctx.orgId)));
  if (!request) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!can(ctx.role, "submissions:view_all") && request.createdBy !== ctx.userId) {
    return NextResponse.json(
      { error: "You can only export your own requests." },
      { status: 403 },
    );
  }

  const fields = await db
    .select()
    .from(requestFields)
    .where(eq(requestFields.requestId, id))
    .orderBy(requestFields.sortOrder);
  const textFields = fields.filter((f) => f.type !== "file_upload");

  const subs = await db
    .select()
    .from(submissions)
    .where(and(eq(submissions.requestId, id), isNull(submissions.purgedAt)));

  // Batch-load all values in one query and reuse each submission's DEK.
  const allValues = subs.length
    ? await db
        .select()
        .from(submissionValues)
        .where(inArray(submissionValues.submissionId, subs.map((s) => s.id)))
    : [];
  const valuesBySubmission = new Map<string, typeof allValues>();
  for (const v of allValues) {
    const list = valuesBySubmission.get(v.submissionId) ?? [];
    list.push(v);
    valuesBySubmission.set(v.submissionId, list);
  }

  const dekCache = createDekCache();
  const rows: Record<string, string>[] = [];
  for (const sub of subs) {
    const values = valuesBySubmission.get(sub.id) ?? [];
    const row: Record<string, string> = {
      submission_id: sub.id,
      status: sub.status,
      submitted_at: sub.submittedAt?.toISOString() ?? "",
      responder_email: sub.responderEmail ?? "",
    };
    for (const f of textFields) {
      const v = values.find((x) => x.fieldId === f.id);
      row[f.label] = v
        ? decryptFieldWithKey(v.valueEncrypted, await dekCache.getKey(v.dekId))
        : "";
    }
    rows.push(row);
  }

  const meta = await requestMeta();
  await audit({
    orgId: ctx.orgId,
    actorType: "org_user",
    actorId: ctx.userId,
    action: `export.data.${format}`,
    targetType: "request",
    targetId: id,
    ...meta,
  });

  if (format === "json") {
    return NextResponse.json(rows, {
      headers: {
        "Content-Disposition": `attachment; filename="recruvault-export-${id}.json"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const headers = rows.length > 0 ? Object.keys(rows[0]) : ["submission_id"];
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const csv = [
    headers.map(escape).join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h] ?? "")).join(",")),
  ].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="recruvault-export-${id}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
