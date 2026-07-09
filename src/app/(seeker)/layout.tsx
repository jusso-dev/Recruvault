import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { requireCandidate, AuthError } from "@/lib/guards";
import { SignOutButton } from "@/components/sign-out";

export default async function SeekerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requireCandidate();
  } catch (err) {
    if (err instanceof AuthError) redirect("/sign-in");
    throw err;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/wallet" className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-5 w-5" aria-hidden />
              Recruvault
            </Link>
            <nav className="flex items-center gap-4 text-sm text-zinc-600">
              <Link href="/wallet" className="hover:text-zinc-900">
                Wallet
              </Link>
              <Link href="/roles" className="hover:text-zinc-900">
                My roles
              </Link>
            </nav>
          </div>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
