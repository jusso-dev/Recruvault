import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "@/db";
import { discoveryProfiles } from "@/db/schema";
import { resolveCandidateContext } from "@/lib/api-auth";
import { ApiError, handle, json } from "@/lib/api/http";
import { audit } from "@/lib/audit";

const CLEARANCE_LEVELS = new Set(["", "baseline", "nv1", "nv2", "pv", "tspa"]);

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await resolveCandidateContext(req);
    const [profile] = await db
      .select({
        discoverable: discoveryProfiles.discoverable,
        clearanceLevel: discoveryProfiles.clearanceLevel,
        skills: discoveryProfiles.skills,
        location: discoveryProfiles.location,
        updatedAt: discoveryProfiles.updatedAt,
      })
      .from(discoveryProfiles)
      .where(eq(discoveryProfiles.candidateAccountId, ctx.candidateAccountId));
    return json({
      profile: profile ?? {
        discoverable: false,
        clearanceLevel: null,
        skills: [],
        location: null,
        updatedAt: null,
      },
    });
  });
}

/** Update the small, non-document discovery profile. Sensitive identity fields are rejected. */
export async function PATCH(req: NextRequest) {
  return handle(async () => {
    const ctx = await resolveCandidateContext(req);
    const body = await req.json().catch(() => {
      throw new ApiError(400, "Invalid JSON body.");
    });
    if ("citizenship" in body || "rightToWork" in body || "policeCheck" in body) {
      throw new ApiError(400, "Identity, right-to-work, and police-check information is not collected.");
    }

    const clearanceLevel = String(body.clearanceLevel ?? "").trim().toLowerCase();
    if (!CLEARANCE_LEVELS.has(clearanceLevel)) {
      throw new ApiError(400, "Choose a supported clearance level.");
    }
    const skills = Array.isArray(body.skills)
      ? body.skills
          .map((value: unknown) => String(value).trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];
    const location = String(body.location ?? "").trim().slice(0, 120) || null;
    const discoverable = body.discoverable === true;
    const [existing] = await db
      .select({ handle: discoveryProfiles.handle })
      .from(discoveryProfiles)
      .where(eq(discoveryProfiles.candidateAccountId, ctx.candidateAccountId));

    await db
      .insert(discoveryProfiles)
      .values({
        candidateAccountId: ctx.candidateAccountId,
        handle: existing?.handle ?? `cand_${randomBytes(5).toString("hex")}`,
        discoverable,
        clearanceLevel: clearanceLevel || null,
        citizenship: null,
        rightToWork: null,
        skills,
        location,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: discoveryProfiles.candidateAccountId,
        set: {
          discoverable,
          clearanceLevel: clearanceLevel || null,
          citizenship: null,
          rightToWork: null,
          skills,
          location,
          updatedAt: new Date(),
        },
      });

    await audit({
      actorType: "candidate",
      actorId: ctx.candidateAccountId,
      action: "discovery.api_updated",
      targetType: "discovery_profile",
      targetId: ctx.candidateAccountId,
    });
    return json({ ok: true });
  });
}
