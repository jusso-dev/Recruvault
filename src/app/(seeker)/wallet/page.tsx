import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  discoveryProfiles,
  organisations,
  walletItems,
  walletShares,
} from "@/db/schema";
import { requireCandidate } from "@/lib/guards";
import { decryptField } from "@/lib/crypto";
import { WALLET_ITEM_TYPES } from "@/lib/fields";
import {
  deleteWalletItem,
  requestErasure,
  revokeWalletShare,
  upsertDiscoveryProfile,
  upsertWalletItem,
} from "@/actions/wallet";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from "@/components/ui";

export default async function WalletPage() {
  const ctx = await requireCandidate();

  const items = await db
    .select()
    .from(walletItems)
    .where(eq(walletItems.candidateAccountId, ctx.candidateAccountId));

  const decrypted = await Promise.all(
    items.map(async (item) => ({
      ...item,
      value: await decryptField(item.valueEncrypted, item.dekId).catch(() => "(unavailable)"),
      label: WALLET_ITEM_TYPES.find((t) => t.type === item.type)?.label ?? item.type,
    })),
  );

  const shares = await db
    .select({
      share: walletShares,
      orgName: organisations.name,
    })
    .from(walletShares)
    .innerJoin(organisations, eq(organisations.id, walletShares.orgId))
    .where(eq(walletShares.candidateAccountId, ctx.candidateAccountId))
    .orderBy(desc(walletShares.consentedAt));

  const missingTypes = WALLET_ITEM_TYPES.filter(
    (t) => !items.some((i) => i.type === t.type),
  );

  const [profile] = await db
    .select()
    .from(discoveryProfiles)
    .where(eq(discoveryProfiles.candidateAccountId, ctx.candidateAccountId));

  return (
    <div className="max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-medium text-accent">Your career record</p>
        <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">
          Profile and credentials
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500">
          Keep your professional details, discovery preferences, and sharing controls
          current. Nothing is shared without your explicit consent.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Reusable credentials</CardTitle>
            <Badge>{decrypted.length} stored</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {decrypted.length === 0 ? (
            <p className="text-sm text-stone-500">No credentials stored yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {decrypted.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-stone-800">{item.label}</p>
                    <p className="mt-0.5 truncate text-stone-500">{item.value}</p>
                  </div>
                  <ActionForm action={deleteWalletItem} successMessage="Credential deleted.">
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="ghost" size="sm">
                      Delete
                    </Button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}

          <ActionForm
            action={upsertWalletItem}
            successMessage="Credential saved."
            resetOnSuccess
            className="grid items-end gap-3 border-t border-stone-100 pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]"
          >
            <div className="flex-1">
              <Label htmlFor="type">Credential</Label>
              <Select id="type" name="type">
                {(missingTypes.length > 0 ? missingTypes : WALLET_ITEM_TYPES).map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex-1">
              <Label htmlFor="value">Value</Label>
              <Input id="value" name="value" required />
            </div>
            <Button type="submit">Save</Button>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recruiter discovery</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 max-w-3xl text-sm leading-6 text-stone-600">
            Opt in to let recruiters find you for suitable roles. Only the facts below
            are shared, as an anonymous match. Your name, contact details, wallet
            credentials, and documents are never exposed until you respond to a role.
            Recruvault does not collect identity, right-to-work, or police-check documents.
          </p>
          <ActionForm action={upsertDiscoveryProfile} successMessage="Discovery updated." className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                name="discoverable"
                defaultChecked={profile?.discoverable ?? false}
              />
              Discoverable by recruiters
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="d_clearance">Clearance level</Label>
                <Select id="d_clearance" name="clearanceLevel" defaultValue={profile?.clearanceLevel ?? ""}>
                  <option value="">None / prefer not to say</option>
                  <option value="baseline">Baseline</option>
                  <option value="nv1">NV1</option>
                  <option value="nv2">NV2</option>
                  <option value="pv">Positive Vetting</option>
                  <option value="tspa">TS-PA</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="d_location">General location</Label>
                <Input id="d_location" name="location" defaultValue={profile?.location ?? ""} placeholder="Canberra, ACT" />
              </div>
            </div>
            <div>
              <Label htmlFor="d_skills">Skills (comma-separated)</Label>
              <Input
                id="d_skills"
                name="skills"
                defaultValue={(profile?.skills ?? []).join(", ")}
                placeholder="systems engineering, ISM, AWS"
              />
            </div>
            <Button type="submit">Save discovery profile</Button>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sharing history</CardTitle>
        </CardHeader>
        <CardContent>
          {shares.length === 0 ? (
            <p className="text-sm text-stone-500">
              You haven&apos;t shared anything from your wallet yet.
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {shares.map(({ share, orgName }) => (
                <li key={share.id} className="flex flex-col justify-between gap-3 py-3 text-sm sm:flex-row sm:items-center">
                  <span className="text-stone-600">
                    Shared with <span className="font-medium">{orgName}</span> on{" "}
                    {share.consentedAt.toLocaleDateString("en-AU")}
                  </span>
                  {share.revokedAt ? (
                    <Badge variant="red">future use revoked</Badge>
                  ) : (
                    <ActionForm action={revokeWalletShare} successMessage="Future access revoked.">
                      <input type="hidden" name="id" value={share.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Revoke future use
                      </Button>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-red-200 bg-red-50/30">
        <CardHeader>
          <CardTitle>Delete everything</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-stone-600">
            Erase your wallet, documents, and submissions. Deletion is a crypto-shred,
            the encryption keys are destroyed and the data is unrecoverable. Type{" "}
            <strong>DELETE</strong> to confirm.
          </p>
          <ActionForm
            action={requestErasure}
            successMessage="Erasure complete. A confirmation email is on its way."
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
          >
            <Input name="confirm" placeholder="DELETE" className="w-32" aria-label="Type DELETE to confirm" />
            <Button type="submit" variant="destructive">
              Erase my data
            </Button>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
