import "server-only";
import { eq, sql } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  candidateAccounts,
  candidateApiKeys,
  dataKeys,
  discoveryProfiles,
  jobAlertSubscriptions,
  orgInvitations,
  organisations,
  savedRoles,
  submissions,
  user,
  vaultKeys,
  walletDocuments,
  walletItems,
  walletShares,
} from "@/db/schema";
import { sha256 } from "@/lib/crypto";
import { sendOrgInvitation } from "@/lib/email";
import { invitationLinkToken } from "@/lib/link-token";
import { consumeOnce } from "@/lib/outbox";

/**
 * Teammate invitations. An owner or admin invites an email address with a
 * role; the invitee accepts at /invite/[token] with a verified account for
 * that address. The token is never stored or logged: the row keeps its hash
 * and the delivery worker rebuilds it from the invitation id.
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const APP_URL = () => process.env.APP_URL ?? "http://localhost:3000";

export type InvitationState = "open" | "accepted" | "revoked" | "expired";

export function invitationState(
  row: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now = new Date(),
): InvitationState {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now) return "expired";
  return "open";
}

export async function findInvitationByToken(token: string) {
  const [row] = await db
    .select({ invitation: orgInvitations, orgName: organisations.name })
    .from(orgInvitations)
    .innerJoin(organisations, eq(organisations.id, orgInvitations.orgId))
    .where(eq(orgInvitations.tokenHash, sha256(token)));
  return row;
}

/** j***@e***.com, enough to recognise the address without disclosing it. */
export function maskEmail(email: string): string {
  const [local, domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  return `${local[0] ?? ""}***@${domain[0] ?? ""}***${dot >= 0 ? domain.slice(dot) : ""}`;
}

type Executor = Pick<typeof db, "select" | "execute">;

/**
 * A job seeker account that already holds a career record cannot become an
 * organisation account: the record would be stranded behind an account type
 * that can no longer open it. Returns the empty candidate row, if any, so the
 * caller can remove it when the account converts.
 */
export async function candidateRecordFor(executor: Executor, userId: string, lock = false) {
  const query = executor
    .select({ id: candidateAccounts.id })
    .from(candidateAccounts)
    .where(eq(candidateAccounts.userId, userId));
  // Inside the accept transaction, hold the row so no career data can be
  // attached to it between this check and the conversion.
  const [candidate] = lock ? await query.for("update") : await query;
  if (!candidate) return { candidateAccountId: null, hasData: false };

  const id = candidate.id;
  const owned = (table: AnyPgTable, column: AnyPgColumn) =>
    sql`exists (select 1 from ${table} where ${column} = ${id})`;
  const keyed = (table: AnyPgTable, ownerType: AnyPgColumn, ownerId: AnyPgColumn) =>
    sql`exists (select 1 from ${table} where ${ownerType} = 'candidate' and ${ownerId} = ${id})`;
  const result = await executor.execute<{ has_data: boolean }>(sql`select (
    ${owned(submissions, submissions.candidateAccountId)}
    or ${owned(walletItems, walletItems.candidateAccountId)}
    or ${owned(walletDocuments, walletDocuments.candidateAccountId)}
    or ${owned(walletShares, walletShares.candidateAccountId)}
    or ${owned(savedRoles, savedRoles.candidateAccountId)}
    or ${owned(jobAlertSubscriptions, jobAlertSubscriptions.candidateAccountId)}
    or ${owned(discoveryProfiles, discoveryProfiles.candidateAccountId)}
    or ${owned(candidateApiKeys, candidateApiKeys.candidateAccountId)}
    or ${keyed(vaultKeys, vaultKeys.ownerType, vaultKeys.ownerId)}
    or ${keyed(dataKeys, dataKeys.ownerType, dataKeys.ownerId)}
  ) as has_data`);
  const row = result.rows[0];
  return { candidateAccountId: id, hasData: Boolean(row?.has_data) };
}

/** Email the invitation once. Closed invitations are skipped. */
export async function sendInvitationEmail(
  invitationId: string,
  send: typeof sendOrgInvitation = sendOrgInvitation,
): Promise<"sent" | "not_sent" | "duplicate" | "skipped"> {
  const [row] = await db
    .select({
      invitation: orgInvitations,
      orgName: organisations.name,
      branding: organisations.branding,
      sendingMode: organisations.sendingMode,
      sendingDomain: organisations.sendingDomain,
      sendingDomainVerifiedAt: organisations.sendingDomainVerifiedAt,
      inviterName: user.name,
    })
    .from(orgInvitations)
    .innerJoin(organisations, eq(organisations.id, orgInvitations.orgId))
    .leftJoin(user, eq(user.id, orgInvitations.invitedBy))
    .where(eq(orgInvitations.id, invitationId));
  if (!row || invitationState(row.invitation) !== "open") return "skipped";

  let outcome: "sent" | "not_sent" = "sent";
  const ran = await consumeOnce(`org-invite/send:${invitationId}`, async () => {
    const { token, tokenHash } = invitationLinkToken(invitationId);
    // The link secret changed since the invitation was created: re-pin it.
    if (tokenHash !== row.invitation.tokenHash) {
      await db.update(orgInvitations).set({ tokenHash }).where(eq(orgInvitations.id, invitationId));
    }
    const messageId = await send({
      to: row.invitation.email,
      org: {
        orgName: row.orgName,
        senderName: row.branding?.senderName,
        sendingMode: row.sendingMode,
        sendingDomain: row.sendingDomain,
        sendingDomainVerifiedAt: row.sendingDomainVerifiedAt,
      },
      role: row.invitation.role,
      inviterName: row.inviterName,
      link: `${APP_URL()}/invite/${token}`,
      expiresAt: row.invitation.expiresAt,
    });
    outcome = messageId ? "sent" : "not_sent";
  });
  return ran === "duplicate" ? "duplicate" : outcome;
}
