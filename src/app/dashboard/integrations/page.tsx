import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { IntegrationGuide } from "@/components/integration-guide";

export default async function RecruiterIntegrationsPage() {
  const ctx = await requireDashboardUser("api:manage");
  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.orgId, ctx.orgId),
        eq(apiKeys.userId, ctx.userId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .orderBy(desc(apiKeys.createdAt));

  return (
    <IntegrationGuide
      audience="recruiter"
      appUrl={process.env.APP_URL ?? "http://localhost:3000"}
      keys={keys}
    />
  );
}
