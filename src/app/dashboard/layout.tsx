import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { requireOrgUser, AuthError } from "@/lib/guards";
import { can } from "@/lib/rbac";
import { SignOutButton } from "@/components/sign-out";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let ctx;
  try {
    ctx = await requireOrgUser();
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.message === "No organisation membership.") redirect("/onboarding");
      redirect("/sign-in");
    }
    throw err;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-5 w-5" aria-hidden />
              Recruvault
            </Link>
            <nav className="flex items-center gap-4 text-sm text-zinc-600">
              <Link href="/dashboard" className="hover:text-zinc-900">
                Requests
              </Link>
              {can(ctx.role, "users:manage") && (
                <Link href="/dashboard/settings" className="hover:text-zinc-900">
                  Settings
                </Link>
              )}
              {can(ctx.role, "audit:view") && (
                <Link href="/dashboard/audit" className="hover:text-zinc-900">
                  Audit
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-500">
              {ctx.orgName} · {ctx.role}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
