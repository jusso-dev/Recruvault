import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { referenceValues } from "@/db/schema";

/**
 * Controlled vocabulary options for a select field: the organisation's own
 * values when configured, otherwise the platform seed (org_id null).
 */
export async function loadOptions(
  orgId: string,
  category: string,
): Promise<{ code: string; label: string; description: string | null }[]> {
  const orgRows = await db
    .select()
    .from(referenceValues)
    .where(
      and(
        eq(referenceValues.orgId, orgId),
        eq(referenceValues.category, category),
        eq(referenceValues.active, true),
      ),
    )
    .orderBy(referenceValues.sortOrder);
  if (orgRows.length > 0) {
    return orgRows.map((r) => ({ code: r.code, label: r.label, description: r.description }));
  }

  const globalRows = await db
    .select()
    .from(referenceValues)
    .where(
      and(
        isNull(referenceValues.orgId),
        eq(referenceValues.category, category),
        eq(referenceValues.active, true),
      ),
    )
    .orderBy(referenceValues.sortOrder);
  return globalRows.map((r) => ({ code: r.code, label: r.label, description: r.description }));
}
