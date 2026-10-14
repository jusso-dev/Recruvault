import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { getSession } from "@/lib/guards";
import { activeVault } from "@/lib/vault-store";
import { rotationStatus } from "@/lib/key-rotation";
import { countLegacyDataKeys } from "@/lib/vault-legacy-migration";
import { cancelVaultRotationAction, migrateLegacyRecords, rotateVault } from "@/actions/vault";
import { VaultKeyFields } from "@/components/vault-key-fields";
import { ActionForm } from "@/components/action-form";
import { Button, Card, CardContent, Input, Label } from "@/components/ui";

export const dynamic = "force-dynamic";

function CurrentKeyField({ passphrase }: { passphrase: boolean }) {
  return passphrase ? (
    <div>
      <Label htmlFor="currentPassphrase">Current passphrase</Label>
      <Input id="currentPassphrase" name="currentPassphrase" type="password" required autoComplete="off" />
    </div>
  ) : (
    <div>
      <Label htmlFor="currentEncryptionKey">Current encryption key</Label>
      <Input id="currentEncryptionKey" name="currentEncryptionKey" type="password" required autoComplete="off" />
    </div>
  );
}

export default async function RotateVaultPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  const org = (session.user as { accountType?: string }).accountType === "org";
  const destination = org ? "/dashboard" : "/overview";
  let owner: { ownerType: "organisation" | "candidate"; ownerId: string };
  if (org) {
    const [membership] = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, session.user.id));
    if (!membership || membership.role !== "owner") redirect("/dashboard");
    owner = { ownerType: "organisation", ownerId: membership.orgId };
  } else {
    const { requireCandidate } = await import("@/lib/guards");
    owner = { ownerType: "candidate", ownerId: (await requireCandidate()).candidateAccountId };
  }
  const vault = await activeVault(owner.ownerType, owner.ownerId);
  if (!vault) redirect("/vault/enroll");
  const [pending, legacy] = await Promise.all([rotationStatus(owner), countLegacyDataKeys(owner)]);
  const passphrase = vault.kdf === "scrypt";

  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="space-y-4 p-6">
          <h1 className="text-xl font-semibold">Rotate encryption key</h1>
          <p className="text-sm leading-6 text-stone-600">
            Rotation rewraps each record&apos;s data key under the new key and switches over only
            after every record verifies. It does not make copies an attacker already decrypted
            unreadable, and backups taken before the switch still need the old key. Keep the old
            key until those backups expire. Recruvault holds no copy of either key: a password
            reset or support request cannot recover them.
          </p>
          <p className="text-sm leading-6 text-stone-600">
            When rotation finishes, every other session must unlock again with the new key and
            integration (API) keys issued before the switch are revoked. Issue new ones afterwards.
          </p>
          {pending && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
              Rotation to version {pending.toVersion} is in progress: {pending.rotated} rewrapped,{" "}
              {pending.remaining} remaining. Submit the same current and new key again to resume, or
              cancel it with the current key below.
            </div>
          )}
          <ActionForm action={rotateVault} redirectTo={destination} successMessage="Encryption key rotation saved." className="space-y-4">
            <CurrentKeyField passphrase={passphrase} />
            <VaultKeyFields />
            <Button type="submit">{pending ? "Resume rotation" : "Rotate key"}</Button>
          </ActionForm>
          {pending && (
            <ActionForm action={cancelVaultRotationAction} redirectTo="/vault/rotate" successMessage="Rotation cancelled." className="space-y-4 border-t border-stone-200 pt-4">
              <p className="text-sm leading-6 text-stone-600">
                Cancelling moves every record back to the current key and discards the new one.
              </p>
              <CurrentKeyField passphrase={passphrase} />
              <Button type="submit" variant="secondary">Cancel rotation</Button>
            </ActionForm>
          )}
          {legacy > 0 && (
            <ActionForm action={migrateLegacyRecords} redirectTo="/vault/rotate" successMessage="Legacy records migrated." className="space-y-3 border-t border-stone-200 pt-4">
              <p className="text-sm leading-6 text-stone-600">
                {legacy} older record{legacy === 1 ? " is" : "s are"} still protected by the deployment
                key. Move them under your encryption key. They stay readable throughout.
              </p>
              <Button type="submit" variant="secondary">Migrate older records</Button>
            </ActionForm>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
