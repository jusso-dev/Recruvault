import { redirect } from "next/navigation";
import { VerifyEmailPanel } from "@/components/verify-email-panel";
import { getSession } from "@/lib/guards";

export default async function VerifyEmailPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in?next=/verify-email");
  if ((session.user as { accountType?: string }).accountType !== "org") {
    redirect("/overview");
  }
  if ((session.user as { emailVerified?: boolean }).emailVerified) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-stone-50 p-4">
      <VerifyEmailPanel email={session.user.email} />
    </main>
  );
}
