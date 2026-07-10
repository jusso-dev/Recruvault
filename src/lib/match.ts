import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { discoveryProfiles } from "@/db/schema";

/**
 * Candidate matching against opt-in discovery profiles. Reads only consented,
 * plaintext facts (never wallet ciphertext or documents) and returns opaque
 * handles, so no PII is exposed to the caller.
 */

// AGSVA clearance levels, lowest to highest. Higher rank satisfies a lower
// requirement (meets-or-exceeds).
const CLEARANCE_ORDER = ["none", "baseline", "nv1", "nv2", "pv", "tspa"];

function clearanceRank(code?: string | null): number {
  const i = CLEARANCE_ORDER.indexOf((code ?? "").toLowerCase());
  return i < 0 ? 0 : i;
}

export interface MatchRequirements {
  clearanceLevel?: string | null;
  skills?: string[];
}

export interface CandidateMatch {
  handle: string;
  score: number;
  matched: string[];
  clearanceLevel: string | null;
  location: string | null;
  skills: string[];
}

/**
 * Score discoverable candidates against a set of requirements. Score is the
 * fraction of specified criteria met (clearance meets-or-exceeds and skills by
 * overlap). Only positive matches are returned.
 */
export async function matchCandidates(
  req: MatchRequirements,
  limit = 20,
): Promise<CandidateMatch[]> {
  const profiles = await db
    .select()
    .from(discoveryProfiles)
    .where(eq(discoveryProfiles.discoverable, true));
  return rankProfiles(profiles, req, limit);
}

export interface ScorableProfile {
  handle: string;
  clearanceLevel: string | null;
  skills: string[] | null;
  location: string | null;
}

/** Pure scoring over already-loaded profiles (DB-free, unit-testable). */
export function rankProfiles(
  profiles: ScorableProfile[],
  req: MatchRequirements,
  limit = 20,
): CandidateMatch[] {
  const reqSkills = (req.skills ?? []).map((s) => s.toLowerCase().trim()).filter(Boolean);
  const results: CandidateMatch[] = [];

  for (const p of profiles) {
    const matched: string[] = [];
    let criteria = 0;

    if (req.clearanceLevel) {
      criteria++;
      if (clearanceRank(p.clearanceLevel) >= clearanceRank(req.clearanceLevel)) {
        matched.push("clearance");
      }
    }
    if (reqSkills.length) {
      criteria++;
      const pSkills = (p.skills ?? []).map((s) => s.toLowerCase());
      const overlap = reqSkills.filter((s) => pSkills.includes(s));
      if (overlap.length) matched.push(`skills:${overlap.length}/${reqSkills.length}`);
    }

    if (criteria === 0 || matched.length === 0) continue;

    results.push({
      handle: p.handle,
      score: Math.round((matched.length / criteria) * 100) / 100,
      matched,
      clearanceLevel: p.clearanceLevel,
      location: p.location,
      skills: p.skills ?? [],
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
