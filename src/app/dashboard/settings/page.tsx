import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organisations, user } from "@/db/schema";
import { requireOrgUser } from "@/lib/guards";
import { addMember, removeMember, updateMemberRole, updateOrgSettings, verifyDomain } from "@/actions/org";
import { ASSIGNABLE_ROLES } from "@/lib/rbac";
import { domainsEnabled, getSendingDomain } from "@/lib/resend-domains";
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

export default async function SettingsPage() {
  const ctx = await requireOrgUser("users:manage");

  const [org] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, ctx.orgId));

  // When a custom domain is registered but unverified, fetch its DNS records
  // from Resend so the admin can copy them into their zone.
  const dns =
    org.sendingDomain && !org.sendingDomainVerifiedAt && org.resendDomainId && domainsEnabled()
      ? await getSendingDomain(org.resendDomainId)
      : null;

  const members = await db
    .select({
      membership: memberships,
      name: user.name,
      email: user.email,
    })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(memberships.orgId, ctx.orgId));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Organisation settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Retention, branding, and sending domain</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={updateOrgSettings}
            successMessage="Settings saved."
            className="space-y-3"
          >
            <div>
              <Label htmlFor="retentionDays">
                Retention — purge submissions this many days after submission
              </Label>
              <Input
                id="retentionDays"
                name="retentionDays"
                type="number"
                min={1}
                max={3650}
                defaultValue={org.retentionDays}
              />
              <p className="mt-1 text-xs text-zinc-500">
                Purged data is crypto-shredded and unrecoverable. The audit trail keeps
                a metadata-only record.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="purgeOnClose" defaultChecked={org.purgeOnClose} />
              Purge after the role closes instead (same day count, measured from close)
            </label>
            <div>
              <Label htmlFor="senderName">Email sender display name</Label>
              <Input
                id="senderName"
                name="senderName"
                defaultValue={org.branding?.senderName ?? ""}
                placeholder={org.name}
              />
            </div>
            <div>
              <Label htmlFor="sendingDomain">Custom sending domain (optional)</Label>
              <Input
                id="sendingDomain"
                name="sendingDomain"
                defaultValue={org.sendingDomain ?? ""}
                placeholder="mail.your-agency.com.au"
              />
              <p className="mt-1 text-xs text-zinc-500">
                {org.sendingDomainVerifiedAt
                  ? `Verified ${org.sendingDomainVerifiedAt.toLocaleDateString("en-AU")}.`
                  : "Requires SPF, DKIM, and DMARC records — verification is completed in Resend. Until verified, mail goes via the shared Recruvault domain with your display name."}
              </p>
            </div>
            <Button type="submit">Save settings</Button>
          </ActionForm>

          {dns && dns.records.length > 0 && (
            <div className="mt-4 space-y-3 border-t border-zinc-100 pt-4">
              <p className="text-sm font-medium">
                Add these DNS records to {org.sendingDomain}, then verify
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="py-1 pr-3">Type</th>
                      <th className="py-1 pr-3">Name</th>
                      <th className="py-1 pr-3">Value</th>
                      <th className="py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {dns.records.map((r, i) => (
                      <tr key={i} className="border-t border-zinc-100 align-top">
                        <td className="py-1 pr-3">{r.type}</td>
                        <td className="py-1 pr-3 break-all">{r.name}</td>
                        <td className="py-1 pr-3 break-all">{r.value}</td>
                        <td className="py-1">
                          <Badge variant={r.status === "verified" ? "green" : "default"}>
                            {r.status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ActionForm action={verifyDomain} successMessage="Sending domain verified.">
                <Button type="submit" variant="secondary" size="sm">
                  Verify DNS now
                </Button>
              </ActionForm>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users and roles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y divide-zinc-100">
            {members.map((m) => (
              <li key={m.membership.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <span className="font-medium">{m.name}</span>
                  <span className="ml-2 text-zinc-500">{m.email}</span>
                </div>
                {m.membership.role === "owner" ? (
                  <Badge>owner</Badge>
                ) : (
                  <div className="flex items-center gap-2">
                    <ActionForm action={updateMemberRole} className="flex items-center gap-2">
                      <input type="hidden" name="membershipId" value={m.membership.id} />
                      <Select
                        name="role"
                        defaultValue={m.membership.role}
                        className="h-8 w-36 text-xs"
                        aria-label={`Role for ${m.email}`}
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                      <Button type="submit" variant="secondary" size="sm">
                        Change
                      </Button>
                    </ActionForm>
                    <ActionForm action={removeMember}>
                      <input type="hidden" name="membershipId" value={m.membership.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Remove
                      </Button>
                    </ActionForm>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <ActionForm
            action={addMember}
            successMessage="Member added."
            resetOnSuccess
            className="flex items-end gap-2"
          >
            <div className="flex-1">
              <Label htmlFor="email">Add member by email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div>
              <Label htmlFor="role">Role</Label>
              <Select id="role" name="role" defaultValue="recruiter">
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit">Add</Button>
          </ActionForm>
          <p className="text-xs text-zinc-500">
            Reviewer = read-only, sees only submissions shared with them (suits an
            end-employer hiring manager). Compliance = read-only across records plus
            full audit access and deletion powers.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
