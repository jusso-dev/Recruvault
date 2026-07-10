import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, type OrgRole, type Permission } from "@/lib/rbac";

/** Full permission set per role — locks the matrix against silent drift. */
const EXPECTED: Record<OrgRole, Permission[]> = {
  owner: [...PERMISSIONS], // owner holds every permission
  admin: [
    "users:manage",
    "branding:manage",
    "retention:manage",
    "templates:manage",
    "requests:create",
    "submissions:view_all",
    "submissions:view_own",
    "submissions:view_shared",
    "documents:view",
    "export:data",
    "export:documents",
    "audit:view",
    "deletion:action",
    "api:manage",
  ],
  recruiter: [
    "templates:manage",
    "requests:create",
    "submissions:view_own",
    "submissions:view_shared",
    "documents:view",
    "export:data",
  ],
  reviewer: ["submissions:view_shared"],
  compliance: [
    "submissions:view_all",
    "submissions:view_own",
    "submissions:view_shared",
    "documents:view",
    "export:data",
    "export:documents",
    "audit:view",
    "deletion:action",
  ],
};

describe("can() permission matrix", () => {
  for (const role of Object.keys(EXPECTED) as OrgRole[]) {
    it(`${role} grants exactly its expected permissions`, () => {
      const granted = PERMISSIONS.filter((p) => can(role, p));
      expect(granted.sort()).toEqual([...EXPECTED[role]].sort());
    });
  }

  it("owner is the only role with org:manage", () => {
    expect(can("owner", "org:manage")).toBe(true);
    for (const role of ["admin", "recruiter", "reviewer", "compliance"] as OrgRole[]) {
      expect(can(role, "org:manage")).toBe(false);
    }
  });

  it("reviewer cannot see all submissions or export", () => {
    expect(can("reviewer", "submissions:view_all")).toBe(false);
    expect(can("reviewer", "export:data")).toBe(false);
    expect(can("reviewer", "audit:view")).toBe(false);
  });

  it("recruiter is not granted blanket export:documents", () => {
    expect(can("recruiter", "export:documents")).toBe(false);
  });
});
