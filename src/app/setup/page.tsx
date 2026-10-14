import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { getSession } from "@/lib/guards";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const [owner] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.role, "owner"))
    .limit(1);
  if (owner) redirect("/sign-in");
  const session = await getSession();

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10 sm:py-16">
      <SetupForm
        signedIn={Boolean(session)}
        emailVerified={Boolean((session?.user as { emailVerified?: boolean } | undefined)?.emailVerified)}
        email={session?.user.email}
      />
    </main>
  );
}
