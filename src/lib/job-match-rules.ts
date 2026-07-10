export interface MatchableRole {
  skills: readonly string[];
  location: string | null;
  employmentType: string | null;
  workArrangement: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
}

export interface JobAlertPreferences {
  skills: readonly string[];
  locations: readonly string[];
  employmentTypes: readonly string[];
  workArrangements: readonly string[];
  minimumSalary: number | null;
}

function normalise(value: string) {
  return value.trim().toLocaleLowerCase("en-AU").replace(/\s+/g, " ");
}

function skillMatches(roleSkill: string, preferredSkill: string) {
  const role = normalise(roleSkill);
  const preferred = normalise(preferredSkill);
  return role === preferred || role.includes(preferred) || preferred.includes(role);
}

export function evaluateJobMatch(
  role: MatchableRole,
  preferences: JobAlertPreferences,
  minimumMatchScore: number,
) {
  const roleSkills = [...new Set(role.skills.map(normalise).filter(Boolean))];
  const preferredSkills = [...new Set(preferences.skills.map(normalise).filter(Boolean))];
  if (roleSkills.length === 0 || preferredSkills.length === 0) {
    return { matches: false, score: 0, matchedSkills: [] as string[], reason: "skills_missing" };
  }

  const matchedSkills = role.skills.filter((roleSkill) =>
    preferredSkills.some((preferredSkill) => skillMatches(roleSkill, preferredSkill)),
  );
  const score = Math.round((new Set(matchedSkills.map(normalise)).size / roleSkills.length) * 100);
  if (score < minimumMatchScore) {
    return { matches: false, score, matchedSkills, reason: "skill_score" };
  }

  if (
    preferences.locations.length > 0 &&
    (!role.location ||
      !preferences.locations.some((location) =>
        normalise(role.location!).includes(normalise(location)),
      ))
  ) {
    return { matches: false, score, matchedSkills, reason: "location" };
  }
  if (
    preferences.employmentTypes.length > 0 &&
    (!role.employmentType || !preferences.employmentTypes.includes(role.employmentType))
  ) {
    return { matches: false, score, matchedSkills, reason: "employment_type" };
  }
  if (
    preferences.workArrangements.length > 0 &&
    (!role.workArrangement || !preferences.workArrangements.includes(role.workArrangement))
  ) {
    return { matches: false, score, matchedSkills, reason: "work_arrangement" };
  }
  const salaryCeiling = role.salaryMax ?? role.salaryMin;
  if (
    preferences.minimumSalary != null &&
    (salaryCeiling == null || salaryCeiling < preferences.minimumSalary)
  ) {
    return { matches: false, score, matchedSkills, reason: "salary" };
  }

  return { matches: true, score, matchedSkills, reason: "matched" };
}
