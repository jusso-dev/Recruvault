import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, memberships, orgInvitations, organisations, user } from "@/db/schema";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { removeMember, updateMemberRole, updateOrgSettings, verifyDomain } from "@/actions/org";
import { inviteMember, revokeInvitation } from "@/actions/invitations";
import { ASSIGNABLE_ROLES, can } from "@/lib/rbac";
import { domainsEnabled, getSendingDomain } from "@/lib/resend-domains";
import { ActionForm } from "@/components/action-form";
import { ApiKeysManager } from "@/components/api-keys-manager";
import { BackupSettings } from "@/components/backup-settings";
import { getPublicBackupConfig, listBackupRuns } from "@/lib/backup";
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
  const ctx = await requireDashboardUser("users:manage");

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

  const invitations = await db
    .select()
    .from(orgInvitations)
    .where(
      and(
        eq(orgInvitations.orgId, ctx.orgId),
        isNull(orgInvitations.acceptedAt),
        isNull(orgInvitations.revokedAt),
        gt(orgInvitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(orgInvitations.createdAt));

  const canManageApi = can(ctx.role, "api:manage");
  const keys = canManageApi
    ? await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.orgId, ctx.orgId), isNull(apiKeys.revokedAt)))
        .orderBy(desc(apiKeys.createdAt))
    : [];

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
                Retention: purge submissions this many days after submission
              </Label>
              <Input
                id="retentionDays"
                name="retentionDays"
                type="number"
                min={1}
                max={3650}
                defaultValue={org.retentionDays}
              />
              <p className="mt-1 text-xs text-stone-500">
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
              <p className="mt-1 text-xs text-stone-500">
                {org.sendingDomainVerifiedAt
                  ? `Verified ${org.sendingDomainVerifiedAt.toLocaleDateString("en-AU")}.`
                  : "Requires SPF, DKIM, and DMARC records. Verification is completed in Resend. Until verified, mail goes via the shared Recruvault domain with your display name."}
              </p>
            </div>
            <Button type="submit">Save settings</Button>
          </ActionForm>

          {dns && dns.records.length > 0 && (
            <div className="mt-4 space-y-3 border-t border-stone-100 pt-4">
              <p className="text-sm font-medium">
                Add these DNS records to {org.sendingDomain}, then verify
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-stone-500">
                    <tr>
                      <th className="py-1 pr-3">Type</th>
                      <th className="py-1 pr-3">Name</th>
                      <th className="py-1 pr-3">Value</th>
                      <th className="py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {dns.records.map((r, i) => (
                      <tr key={i} className="border-t border-stone-100 align-top">
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
          <ul className="divide-y divide-stone-100">
            {members.map((m) => (
              <li key={m.membership.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <span className="font-medium">{m.name}</span>
                  <span className="ml-2 text-stone-500">{m.email}</span>
                </div>
                {m.membership.role === "owner" ? (
                  <Badge>owner</Badge>
                ) : (
                  <div className="flex items-center gap-2">
                    <ActionForm
                      action={updateMemberRole}
                      successMessage="Member role updated."
                      className="flex items-center gap-2"
                    >
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
                    <ActionForm
                      action={removeMember}
                      successMessage="Member removed."
                      confirm={{
                        title: `Remove ${m.name}?`,
                        body: `${m.email} loses access to this organisation straight away and their API keys are revoked. To restore access, send a new invitation.`,
                        confirmLabel: "Remove member",
                      }}
                    >
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

          {invitations.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-stone-700">Pending invitations</h3>
              <ul className="mt-1 divide-y divide-stone-100">
                {invitations.map((invitation) => (
                  <li key={invitation.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium">{invitation.email}</span>
                      <span className="tnum ml-2 text-stone-500">
                        {invitation.role} · expires {invitation.expiresAt.toLocaleDateString("en-AU")}
                      </span>
                    </div>
                    <ActionForm
                      action={revokeInvitation}
                      successMessage="Invitation revoked."
                      confirm={{
                        title: "Revoke this invitation?",
                        body: `The link sent to ${invitation.email} stops working. You can send a new invitation later.`,
                        confirmLabel: "Revoke invitation",
                      }}
                    >
                      <input type="hidden" name="invitationId" value={invitation.id} />
                      <Button type="submit" variant="ghost" size="sm" aria-label={`Revoke invitation for ${invitation.email}`}>
                        Revoke
                      </Button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ActionForm
            action={inviteMember}
            successMessage="Invitation sent."
            resetOnSuccess
            className="flex items-end gap-2"
          >
            <div className="flex-1">
              <Label htmlFor="email">Invite by email</Label>
              <Input id="email" name="email" type="email" required autoComplete="off" />
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
            <Button type="submit">Send invitation</Button>
          </ActionForm>
          <p className="text-xs text-stone-500">
            Invitations expire after 7 days and work once. The invitee signs in or creates an
            account with the invited address, then needs the organisation encryption key from
            the owner before they can open records. Share it through a separate, trusted channel.
          </p>
          <p className="text-xs text-stone-500">
            Reviewer = read-only, sees only submissions shared with them (suits an
            end-employer hiring manager). Compliance = read-only across records plus
            full audit access and deletion powers.
          </p>
        </CardContent>
      </Card>

      {ctx.role === "owner" && (
        <Card>
          <CardHeader>
            <CardTitle>Nightly encrypted backups</CardTitle>
          </CardHeader>
          <CardContent>
            <BackupSettings
              config={await getPublicBackupConfig()}
              runs={await listBackupRuns()}
            />
          </CardContent>
        </Card>
      )}

      {canManageApi && (
        <Card>
          <CardHeader>
            <CardTitle>API keys</CardTitle>
          </CardHeader>
          <CardContent>
            <ApiKeysManager keys={keys} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
