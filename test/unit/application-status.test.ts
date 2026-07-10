import { describe, expect, it } from "vitest";
import {
  RECRUITER_APPLICATION_STATUSES,
  applicationStatusLabel,
} from "@/lib/application-status";
import {
  allowedTypesForWalletDocument,
  ROLE_REQUEST_FIELD_KEYS,
  WALLET_DOCUMENT_TYPES,
} from "@/lib/fields";

describe("application workflow", () => {
  it("supports placement stages from shortlist through placed", () => {
    expect(RECRUITER_APPLICATION_STATUSES).toEqual(
      expect.arrayContaining(["shortlisted", "interview", "offer", "placed"]),
    );
    expect(applicationStatusLabel("placed")).toBe("Placed");
    expect(applicationStatusLabel("follow_up")).toBe("More information needed");
  });

  it("accepts Word files for resumes and cover letters", () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(allowedTypesForWalletDocument("resume")).toContain(docx);
    expect(allowedTypesForWalletDocument("cover_letter")).toContain(docx);
    expect(allowedTypesForWalletDocument("passport")).toEqual([]);
  });

  it("only offers career documents to job seekers", () => {
    expect(WALLET_DOCUMENT_TYPES.map((type) => type.type)).toEqual([
      "resume",
      "cover_letter",
    ]);
    expect(WALLET_DOCUMENT_TYPES.some((type) => String(type.type) === "passport")).toBe(false);
    expect(WALLET_DOCUMENT_TYPES.some((type) => String(type.type) === "police_check")).toBe(false);
  });

  it("limits new role requirements to the four supported items", () => {
    expect(ROLE_REQUEST_FIELD_KEYS).toEqual([
      "clearance_level",
      "clearance_id",
      "resume",
      "cover_letter",
    ]);
  });
});
