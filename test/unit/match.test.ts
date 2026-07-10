import { describe, expect, it } from "vitest";
import { rankProfiles, type ScorableProfile } from "@/lib/match";

const p = (over: Partial<ScorableProfile>): ScorableProfile => ({
  handle: "cand_x",
  clearanceLevel: null,
  citizenship: null,
  rightToWork: null,
  skills: [],
  location: null,
  ...over,
});

describe("rankProfiles", () => {
  it("treats clearance as meets-or-exceeds", () => {
    const profiles = [
      p({ handle: "nv2", clearanceLevel: "nv2" }),
      p({ handle: "baseline", clearanceLevel: "baseline" }),
    ];
    const res = rankProfiles(profiles, { clearanceLevel: "nv1" });
    const handles = res.map((r) => r.handle);
    expect(handles).toContain("nv2"); // NV2 exceeds NV1
    expect(handles).not.toContain("baseline"); // baseline is below NV1
  });

  it("scores full match higher than partial", () => {
    const profiles = [
      p({ handle: "full", clearanceLevel: "nv2", citizenship: "au_citizen" }),
      p({ handle: "partial", clearanceLevel: "nv2", citizenship: "other" }),
    ];
    const res = rankProfiles(profiles, { clearanceLevel: "nv1", citizenship: "au_citizen" });
    expect(res[0].handle).toBe("full");
    expect(res[0].score).toBe(1);
    expect(res.find((r) => r.handle === "partial")?.score).toBeLessThan(1);
  });

  it("matches skills by overlap, case-insensitive", () => {
    const profiles = [p({ handle: "sk", skills: ["AWS", "ISM", "Terraform"] })];
    const res = rankProfiles(profiles, { skills: ["aws", "ism"] });
    expect(res).toHaveLength(1);
    expect(res[0].matched.some((m) => m.startsWith("skills:2/2"))).toBe(true);
  });

  it("excludes profiles that meet no criteria", () => {
    const profiles = [p({ handle: "none", citizenship: "other" })];
    expect(rankProfiles(profiles, { citizenship: "au_citizen" })).toHaveLength(0);
  });

  it("returns nothing when no requirements are given", () => {
    expect(rankProfiles([p({ clearanceLevel: "nv2" })], {})).toHaveLength(0);
  });
});
