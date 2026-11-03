import { describe, expect, it } from "vitest";
import { canWithdrawApplication } from "@/lib/application-status";
import { safeNextPath } from "@/lib/utils";
import { sanitizeUrl } from "@/lib/redact";

describe("post-auth redirect paths", () => {
  it("keeps same-origin paths only", () => {
    expect(safeNextPath("/invite/abc")).toBe("/invite/abc");
    expect(safeNextPath("/dashboard?x=1")).toBe("/dashboard?x=1");
    for (const bad of [null, undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", "invite"]) {
      expect(safeNextPath(bad)).toBeNull();
    }
  });
});

describe("invitation links in telemetry", () => {
  it("redact the token from paths and next parameters", () => {
    const token = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0nOp3";
    expect(sanitizeUrl(`https://app.example/invite/${token}`)).not.toContain(token);
    expect(sanitizeUrl(`https://app.example/sign-in?next=%2Finvite%2F${token}`)).not.toContain(token);
  });
});

describe("application withdrawal", () => {
  it("allows only active, submitted applications", () => {
    for (const status of ["received", "under_review", "shortlisted", "interview", "offer", "accepted", "follow_up"]) {
      expect(canWithdrawApplication(status)).toBe(true);
    }
    for (const status of ["started", "placed", "declined", "withdrawn"]) {
      expect(canWithdrawApplication(status)).toBe(false);
    }
  });
});
