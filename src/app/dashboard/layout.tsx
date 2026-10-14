import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { activeVault } from "@/lib/vault-store";
import { readUnlockedCustomerKey } from "@/lib/vault-session";
import { can } from "@/lib/rbac";
import { AppShell, type AppNavItem } from "@/components/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireDashboardUser();
  const vault = await activeVault("organisation", ctx.orgId);
  if (!vault) redirect(ctx.role === "owner" ? "/vault/enroll" : "/vault/waiting");
  if (!(await readUnlockedCustomerKey("organisation", ctx.orgId))) {
    redirect("/vault/unlock?next=/dashboard");
  }

  const nav: AppNavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "overview" },
  ];

  if (can(ctx.role, "requests:create")) {
    nav.push({ href: "/dashboard/requests/new", label: "New role", icon: "requests", exact: true });
    nav.push({ href: "/dashboard/job-alerts", label: "Matched alerts", icon: "alerts" });
  }
  if (can(ctx.role, "api:manage")) {
    nav.push({ href: "/dashboard/integrations", label: "API & MCP", icon: "integrations" });
  }

  if (can(ctx.role, "audit:view")) {
    nav.push({ href: "/dashboard/audit", label: "Audit trail", icon: "audit" });
  }
  if (can(ctx.role, "users:manage")) {
    nav.push({ href: "/dashboard/settings", label: "Settings", icon: "settings" });
  }

  return (
    <AppShell
      brandHref="/dashboard"
      workspaceName={ctx.orgName}
      workspaceMeta={ctx.role}
      userName={ctx.userName}
      nav={nav}
    >
      {children}
    </AppShell>
  );
}
