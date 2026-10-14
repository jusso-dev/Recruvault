import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { getSession } from "@/lib/guards";
import { activeVault } from "@/lib/vault-store";
import { unlockVault } from "@/actions/vault";
import { ActionForm } from "@/components/action-form";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function UnlockVaultPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  const nextParam = (await searchParams).next;
  const org = (session.user as { accountType?: string }).accountType === "org";
  let vault: { kdf: string | null } | null = null;
  let destination = org ? "/dashboard" : "/overview";
  if (org) {
    const [membership] = await db
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id));
    if (!membership) redirect("/onboarding");
    vault = await activeVault("organisation", membership.orgId);
  } else {
    const { requireCandidate } = await import("@/lib/guards");
    const ctx = await requireCandidate();
    vault = await activeVault("candidate", ctx.candidateAccountId);
  }
  if (!vault) redirect("/vault/enroll");
  if (nextParam?.startsWith("/")) destination = nextParam;

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-6">
          <h1 className="text-xl font-semibold">Unlock encryption key</h1>
          <p className="text-sm leading-6 text-stone-600">
            Sign-in proves who you are. This key proves you can read the workspace.
            A password reset does not replace it. Closing the browser locks it again.
            If the key is gone, Recruvault cannot open the existing career records.
          </p>
          <ActionForm action={unlockVault} redirectTo={destination} className="space-y-4">
            <input type="hidden" name="next" value={destination} />
            {vault.kdf === "scrypt" ? (
              <div>
                <Label htmlFor="passphrase">Passphrase</Label>
                <Input id="passphrase" name="passphrase" type="password" required autoComplete="current-password" />
              </div>
            ) : (
              <div>
                <Label htmlFor="encryptionKey">Encryption key</Label>
                <Input id="encryptionKey" name="encryptionKey" type="password" required autoComplete="off" />
              </div>
            )}
            <Button type="submit" className="w-full">Unlock vault</Button>
          </ActionForm>
        </CardContent>
      </Card>
    </main>
  );
}
