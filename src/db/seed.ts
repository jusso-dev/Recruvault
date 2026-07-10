/**
 * Seed the platform reference data (org_id null): AGSVA clearance levels,
 * clearance levels.
 * Idempotent — safe to run on every deploy. Run: npm run db:seed
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./index";
import { referenceValues } from "./schema";
import { REFERENCE_SEED } from "@/lib/fields";

async function main() {
  for (const seed of REFERENCE_SEED) {
    const [existing] = await db
      .select({ id: referenceValues.id })
      .from(referenceValues)
      .where(
        and(
          isNull(referenceValues.orgId),
          eq(referenceValues.category, seed.category),
          eq(referenceValues.code, seed.code),
        ),
      );
    if (existing) {
      await db
        .update(referenceValues)
        .set({
          label: seed.label,
          description: seed.description,
          sortOrder: seed.sortOrder,
        })
        .where(eq(referenceValues.id, existing.id));
    } else {
      await db.insert(referenceValues).values({
        category: seed.category,
        code: seed.code,
        label: seed.label,
        description: seed.description,
        sortOrder: seed.sortOrder,
      });
    }
  }
  console.log(`Seeded ${REFERENCE_SEED.length} reference values.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
