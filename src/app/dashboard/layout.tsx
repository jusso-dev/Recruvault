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
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-stone-50/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-7">
            <Link
              href="/dashboard"
              className="flex items-center gap-2 font-semibold tracking-tight text-stone-900"
            >
              <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
              Recruvault
            </Link>
            <nav className="flex items-center gap-5 text-sm font-medium text-stone-600">
              <Link href="/dashboard" className="transition-colors hover:text-accent">
                Requests
              </Link>
              {can(ctx.role, "users:manage") && (
                <Link href="/dashboard/settings" className="transition-colors hover:text-accent">
                  Settings
                </Link>
              )}
              {can(ctx.role, "audit:view") && (
                <Link href="/dashboard/audit" className="transition-colors hover:text-accent">
                  Audit
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-stone-500 sm:inline">
              {ctx.orgName} <span className="text-stone-300">·</span>{" "}
              <span className="capitalize">{ctx.role}</span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
