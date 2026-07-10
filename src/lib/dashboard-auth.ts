import "server-only";

import { redirect } from "next/navigation";
import { AuthError, resolveOrgUser, type OrgContext } from "@/lib/guards";
import type { Permission } from "@/lib/rbac";

/**
 * Resolve expected dashboard access states before rendering. Expected account
 * states use explicit routes; only genuine permission or data-integrity
 * failures reach the dashboard error boundary.
 */
export async function requireDashboardUser(permission?: Permission): Promise<OrgContext> {
  const access = await resolveOrgUser(permission);
  if (access.ok) return access.context;

  switch (access.reason) {
    case "sign_in":
      redirect("/sign-in?next=/dashboard");
    case "wrong_account":
      redirect("/overview");
    case "verification_required":
      redirect("/verify-email");
    case "no_membership":
      redirect("/onboarding");
    default:
      throw new AuthError(access.message);
  }
}
