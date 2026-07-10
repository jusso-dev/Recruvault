"use server";

import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organisations, user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getSession, requestMeta } from "@/lib/guards";
import type { ActionResult } from "@/actions/org";

function organisationSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const suffix = createHash("sha256").update(`${name}:${Date.now()}`).digest("hex").slice(0, 6);
  return `${base || "organisation"}-${suffix}`;
}

/** Complete the one-time platform bootstrap after BetterAuth creates the owner. */
export async function completePlatformSetup(formData: FormData): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Your account was created, but the session could not be started. Sign in and try again." };
  if ((session.user as { accountType?: string }).accountType !== "org") {
    return { ok: false, error: "A recruiter account is required for setup." };
  }

  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const organisationName = String(formData.get("organisationName") ?? "").trim();
  if (!firstName || !lastName) return { ok: false, error: "Enter your first and last name." };
  if (!organisationName) return { ok: false, error: "Enter your organisation name." };

  const result = await db.transaction(async (tx) => {
    // Serialise first-owner setup so two simultaneous requests cannot create
    // two bootstrap organisations.
    await tx.execute(sql`select pg_advisory_xact_lock(814726391)`);
    const [existing] = await tx.select({ id: organisations.id }).from(organisations).limit(1);
    if (existing) return { existing: true as const };

    await tx
      .update(user)
      .set({
        name: `${firstName} ${lastName}`,
        accountType: "org",
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(sql`${user.id} = ${session.user.id}`);

    const [organisation] = await tx
      .insert(organisations)
      .values({ name: organisationName, slug: organisationSlug(organisationName) })
      .returning({ id: organisations.id });
    await tx.insert(memberships).values({
      orgId: organisation.id,
      userId: session.user.id,
      role: "owner",
    });
    return { existing: false as const, organisationId: organisation.id };
  });

  if (result.existing) {
    return { ok: false, error: "Recruvault has already been set up. Sign in instead." };
  }

  const meta = await requestMeta();
  await audit({
    orgId: result.organisationId,
    actorType: "org_user",
    actorId: session.user.id,
    action: "platform.setup_completed",
    targetType: "organisation",
    targetId: result.organisationId,
    ...meta,
  });
  return { ok: true, id: result.organisationId };
}
