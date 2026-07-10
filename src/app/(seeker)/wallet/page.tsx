import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { organisations, walletDocuments, walletItems, walletShares } from "@/db/schema";
import { requireCandidate } from "@/lib/guards";
import { decryptField } from "@/lib/crypto";
import { WALLET_ITEM_TYPES } from "@/lib/fields";
import {
  deleteWalletDocument,
  deleteWalletItem,
  requestErasure,
  revokeWalletShare,
  upsertWalletItem,
  uploadWalletDocument,
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
  statusBadgeVariant,
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

  const docs = await db
    .select()
    .from(walletDocuments)
    .where(eq(walletDocuments.candidateAccountId, ctx.candidateAccountId));

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Your wallet</h1>
        <p className="text-sm text-stone-500">
          Enter your credentials once, reuse them across roles with explicit consent.
          Everything here is encrypted and private by default — nothing leaves the
          wallet until you consent to share it with a specific request. Wallet data is
          self-declared; recruiters review it themselves.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {decrypted.length === 0 ? (
            <p className="text-sm text-stone-500">No credentials stored yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {decrypted.map((item) => (
                <li key={item.id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <span className="font-medium">{item.label}</span>
                    <span className="ml-2 text-stone-500">{item.value}</span>
                  </div>
                  <ActionForm action={deleteWalletItem}>
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
            successMessage="Saved."
            resetOnSuccess
            className="flex items-end gap-2"
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
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {docs.length === 0 ? (
            <p className="text-sm text-stone-500">No documents stored yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{d.kind.replace("_", " ")}</span>
                    <span className="text-stone-500">{d.fileName}</span>
                    <Badge variant={statusBadgeVariant(d.scanStatus)}>{d.scanStatus}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {d.scanStatus === "clean" && (
                      <a href={`/api/wallet/documents/${d.id}/view`} target="_blank" rel="noreferrer">
                        <Button variant="secondary" size="sm">
                          View
                        </Button>
                      </a>
                    )}
                    <ActionForm action={deleteWalletDocument}>
                      <input type="hidden" name="id" value={d.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <ActionForm
            action={uploadWalletDocument}
            successMessage="Uploaded — it will be available once virus scanning completes."
            resetOnSuccess
            className="flex items-end gap-2"
          >
            <div>
              <Label htmlFor="kind">Type</Label>
              <Select id="kind" name="kind">
                <option value="passport">Passport</option>
                <option value="driver_licence">Driver licence</option>
                <option value="other">Other evidence</option>
              </Select>
            </div>
            <div className="flex-1">
              <Label htmlFor="file">File (PDF or image, max 15 MB)</Label>
              <Input id="file" name="file" type="file" accept="application/pdf,image/*" required />
            </div>
            <Button type="submit">Upload</Button>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sharing history (consent ledger)</CardTitle>
        </CardHeader>
        <CardContent>
          {shares.length === 0 ? (
            <p className="text-sm text-stone-500">
              You haven&apos;t shared anything from your wallet yet.
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {shares.map(({ share, orgName }) => (
                <li key={share.id} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    Shared with <span className="font-medium">{orgName}</span> on{" "}
                    {share.consentedAt.toLocaleDateString("en-AU")}
                  </span>
                  {share.revokedAt ? (
                    <Badge variant="red">future use revoked</Badge>
                  ) : (
                    <ActionForm action={revokeWalletShare}>
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

      <Card className="border-red-200">
        <CardHeader>
          <CardTitle>Delete everything</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-stone-600">
            Erase your wallet, documents, and submissions. Deletion is a crypto-shred —
            the encryption keys are destroyed and the data is unrecoverable. Type{" "}
            <strong>DELETE</strong> to confirm.
          </p>
          <ActionForm
            action={requestErasure}
            successMessage="Erasure complete. A confirmation email is on its way."
            className="flex items-center gap-2"
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
