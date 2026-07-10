export function recruiterSignupEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
) {
  return env.ALLOW_RECRUITER_SIGNUP === "true";
}
