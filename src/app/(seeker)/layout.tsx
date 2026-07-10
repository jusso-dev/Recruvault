import { redirect } from "next/navigation";
import { requireCandidate, AuthError } from "@/lib/guards";
import { AppShell, type AppNavItem } from "@/components/app-shell";

export default async function SeekerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let ctx;
  try {
    ctx = await requireCandidate();
  } catch (err) {
    if (err instanceof AuthError) redirect("/sign-in");
    throw err;
  }

  const nav: AppNavItem[] = [
    { href: "/overview", label: "Overview", icon: "overview", exact: true },
    { href: "/roles", label: "Applications", icon: "roles" },
    { href: "/documents", label: "Career documents", icon: "documents" },
    { href: "/wallet", label: "Profile & credentials", icon: "wallet" },
    { href: "/integrations", label: "API & MCP", icon: "integrations" },
  ];

  return (
    <AppShell
      brandHref="/overview"
      workspaceName="Personal workspace"
      workspaceMeta="Job seeker"
      userName={ctx.userName}
      nav={nav}
    >
      {children}
    </AppShell>
  );
}
