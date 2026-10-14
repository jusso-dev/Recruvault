import { redirect } from "next/navigation";
import { getSession } from "@/lib/guards";
import { isPlatformBootstrapped } from "@/lib/platform-bootstrap";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isPlatformBootstrapped()) redirect("/sign-in");
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
