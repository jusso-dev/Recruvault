import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { getSession } from "@/lib/guards";
import { activeVault } from "@/lib/vault-store";
import { rotateVault } from "@/actions/vault";
import { VaultKeyFields } from "@/components/vault-key-fields";
import { ActionForm } from "@/components/action-form";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RotateVaultPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  const org = (session.user as { accountType?: string }).accountType === "org";
  const destination = org ? "/dashboard" : "/overview";
  if (org) {
    const [membership] = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id));
    if (!membership || membership.role !== "owner") redirect("/dashboard");
    if (!(await activeVault("organisation", membership.orgId))) redirect("/vault/enroll");
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-6">
          <h1 className="text-xl font-semibold">Rotate encryption key</h1>
          <p className="text-sm leading-6 text-stone-600">
            Rotation rewraps data keys. It does not rewrite document bytes, and it does
            not make copies an attacker already decrypted unreadable. Enter the current
            key and a new one. If the run is interrupted, submit the same pair again.
          </p>
          <ActionForm action={rotateVault} redirectTo={destination} successMessage="Encryption key rotated." className="space-y-4">
            <div>
              <Label htmlFor="currentEncryptionKey">Current encryption key</Label>
              <Input id="currentEncryptionKey" name="currentEncryptionKey" type="password" autoComplete="off" />
            </div>
            <VaultKeyFields />
            <Button type="submit">Rotate key</Button>
          </ActionForm>
        </CardContent>
      </Card>
    </main>
  );
}
