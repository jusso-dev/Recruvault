import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { candidateApiKeys } from "@/db/schema";
import { requireCandidate } from "@/lib/guards";
import { IntegrationGuide } from "@/components/integration-guide";

export default async function CandidateIntegrationsPage() {
  const ctx = await requireCandidate();
  const keys = await db
    .select({
      id: candidateApiKeys.id,
      name: candidateApiKeys.name,
      prefix: candidateApiKeys.prefix,
      lastUsedAt: candidateApiKeys.lastUsedAt,
      createdAt: candidateApiKeys.createdAt,
    })
    .from(candidateApiKeys)
    .where(
      and(
        eq(candidateApiKeys.candidateAccountId, ctx.candidateAccountId),
        isNull(candidateApiKeys.revokedAt),
      ),
    )
    .orderBy(desc(candidateApiKeys.createdAt));

  return (
    <IntegrationGuide
      audience="candidate"
      appUrl={process.env.APP_URL ?? "http://localhost:3000"}
      keys={keys}
    />
  );
}
