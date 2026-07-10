import { describe, expect, it } from "vitest";
import { recruiterSignupEnabled } from "@/lib/signup-policy";

describe("recruiterSignupEnabled", () => {
  it("keeps recruiter self-registration closed by default", () => {
    expect(recruiterSignupEnabled({})).toBe(false);
  });

  it("opens recruiter self-registration only for the explicit true value", () => {
    expect(recruiterSignupEnabled({ ALLOW_RECRUITER_SIGNUP: "true" })).toBe(true);
    expect(recruiterSignupEnabled({ ALLOW_RECRUITER_SIGNUP: "false" })).toBe(false);
    expect(recruiterSignupEnabled({ ALLOW_RECRUITER_SIGNUP: "1" })).toBe(false);
  });
});
