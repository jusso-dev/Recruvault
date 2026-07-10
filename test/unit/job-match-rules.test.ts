import { describe, expect, it } from "vitest";
import { evaluateJobMatch } from "@/lib/job-match-rules";

const role = {
  skills: ["Azure", "Docker", "GitHub Actions", "Microsoft Sentinel"],
  location: "Canberra, ACT",
  employmentType: "contract",
  workArrangement: "hybrid",
  salaryMin: 1_200,
  salaryMax: 1_400,
};

const preferences = {
  skills: ["azure", "Docker", "TypeScript"],
  locations: [] as string[],
  employmentTypes: [] as string[],
  workArrangements: [] as string[],
  minimumSalary: null,
};

describe("job alert matching", () => {
  it("matches skills case-insensitively and calculates role coverage", () => {
    expect(evaluateJobMatch(role, preferences, 50)).toMatchObject({
      matches: true,
      score: 50,
      matchedSkills: ["Azure", "Docker"],
    });
  });

  it("honours the recruiter match threshold", () => {
    expect(evaluateJobMatch(role, preferences, 75)).toMatchObject({
      matches: false,
      score: 50,
      reason: "skill_score",
    });
  });

  it("requires every job-seeker filter that was explicitly selected", () => {
    expect(
      evaluateJobMatch(
        role,
        {
          ...preferences,
          locations: ["Sydney"],
          employmentTypes: ["permanent"],
        },
        50,
      ),
    ).toMatchObject({ matches: false, reason: "location" });
  });

  it("rejects roles below the requested salary or rate", () => {
    expect(
      evaluateJobMatch(role, { ...preferences, minimumSalary: 1_500 }, 50),
    ).toMatchObject({ matches: false, reason: "salary" });
  });

  it("does not generate broad alerts when either side has no skills", () => {
    expect(evaluateJobMatch({ ...role, skills: [] }, preferences, 1)).toMatchObject({
      matches: false,
      reason: "skills_missing",
    });
  });
});
