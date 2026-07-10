import { requireDashboardUser } from "@/lib/dashboard-auth";
import { can } from "@/lib/rbac";
import { AppShell, type AppNavItem } from "@/components/app-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireDashboardUser();

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
