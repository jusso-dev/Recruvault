import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { getSession } from "@/lib/guards";
import { createOrganisation } from "@/actions/org";
import { ActionForm } from "@/components/action-form";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  if ((session.user as { accountType?: string }).accountType !== "org") {
    redirect("/overview");
  }
  if (!(session.user as { emailVerified?: boolean }).emailVerified) {
    redirect("/verify-email");
  }

  const [existing] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, session.user.id));
  if (existing) redirect("/dashboard");

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4">
          <h1 className="text-xl font-semibold">Create your organisation</h1>
          <p className="text-sm text-stone-600">
            You&apos;ll be the owner: full control over users, roles, retention,
            and branding.
          </p>
          <ActionForm action={createOrganisation} redirectTo="/dashboard" className="space-y-3">
            <div>
              <Label htmlFor="name">Organisation name</Label>
              <Input id="name" name="name" required placeholder="Acme Talent Pty Ltd" />
            </div>
            <Button type="submit" className="w-full">
              Create organisation
            </Button>
          </ActionForm>
        </CardContent>
      </Card>
    </main>
  );
}
