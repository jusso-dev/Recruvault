import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { getSession } from "@/lib/guards";
import { activeVault } from "@/lib/vault-store";
import { enrollVault } from "@/actions/vault";
import { VaultKeyFields } from "@/components/vault-key-fields";
import { Button, Card, CardContent } from "@/components/ui";
import { ActionForm } from "@/components/action-form";

export const dynamic = "force-dynamic";

export default async function EnrollVaultPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  const org = (session.user as { accountType?: string }).accountType === "org";
  const next = org ? "/dashboard" : "/overview";
  if (org) {
    const [membership] = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id));
    if (!membership) redirect("/onboarding");
    if (membership.role !== "owner") redirect("/vault/waiting");
    if (await activeVault("organisation", membership.orgId)) redirect("/vault/unlock");
  } else {
    const { requireCandidate } = await import("@/lib/guards");
    const ctx = await requireCandidate();
    if (await activeVault("candidate", ctx.candidateAccountId)) redirect("/vault/unlock");
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-6">
          <h1 className="text-xl font-semibold">Create your encryption key</h1>
          <p className="text-sm leading-6 text-stone-600">
            Career records stay unreadable until this key is enrolled. The server can use it
            only while this session is unlocked. A database copy alone does not reveal it.
            There is no reset. Losing the key means those records cannot be opened again.
          </p>
          <ActionForm action={enrollVault} redirectTo={next} className="space-y-4">
            <VaultKeyFields />
            <Button type="submit" className="w-full">Save encryption key</Button>
          </ActionForm>
        </CardContent>
      </Card>
    </main>
  );
}
