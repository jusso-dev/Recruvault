import { describe, expect, it } from "vitest";
import { userFacingError } from "@/lib/user-facing-errors";

describe("userFacingError", () => {
  it("turns authentication failures into actionable copy", () => {
    expect(userFacingError("Invalid email or password")).toBe(
      "We couldn’t sign you in. Check your email and password, then try again.",
    );
  });

  it("does not expose permission identifiers", () => {
    expect(userFacingError("Your role does not allow this action (users:manage).")).toBe(
      "You don’t have permission to do that. Ask your organisation owner if you need access.",
    );
  });

  it("hides technical implementation errors", () => {
    expect(userFacingError("TypeError: cannot read property at app.ts:12:4")).toBe(
      "We couldn’t complete that. Please try again.",
    );
  });

  it("keeps already friendly validation messages", () => {
    expect(userFacingError("Choose a file to upload.")).toBe("Choose a file to upload.");
  });
});
