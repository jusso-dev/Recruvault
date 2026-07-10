/**
 * RBAC: permissions are discrete actions, roles are bundles of permissions.
 * This mirrors the PRD permission matrix exactly. Fixed roles ship first;
 * custom roles and per-permission overrides are a later enhancement.
 *
 * Authorisation is enforced in the data layer (see lib/guards.ts) — every
 * read checks tenant (org_id) and ownership, never just the UI.
 */

export type OrgRole = "owner" | "admin" | "recruiter" | "reviewer" | "compliance";

export const PERMISSIONS = [
  "org:manage",
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  owner: [
    "org:manage",
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
    "api:manage",
    // "export:documents" is by org policy for recruiters; enforced at the
    // export call site, not granted as a blanket permission here.
  ],
  reviewer: [
    // Read-only: sees only submissions explicitly shared with them, documents
    // on those submissions, no exports.
    "submissions:view_shared",
  ],
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

export function can(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const ASSIGNABLE_ROLES: OrgRole[] = [
  "admin",
  "recruiter",
  "reviewer",
  "compliance",
];
