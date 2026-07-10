import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  candidateAccounts,
  jobAlertSubscriptions,
  jobMatchNotifications,
  organisations,
  recruiterMatchSettings,
  requests,
  user,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { sendJobMatchAlert } from "@/lib/email";
import { evaluateJobMatch } from "@/lib/job-match-rules";

const ACTIVE_STATUSES = new Set(["open", "closing_soon"]);
const MAX_ALERTS_PER_CANDIDATE_PER_DAY = 5;

export async function queueJobMatches(scope: {
  requestId?: string;
  candidateAccountId?: string;
}) {
  const roleRows = await db
    .select({
      id: requests.id,
      orgId: requests.orgId,
      title: requests.title,
      skills: requests.skills,
      location: requests.location,
      employmentType: requests.employmentType,
      workArrangement: requests.workArrangement,
      salaryMin: requests.salaryMin,
      salaryMax: requests.salaryMax,
      status: requests.status,
      listed: requests.listed,
      expiresAt: requests.expiresAt,
      minimumMatchScore: recruiterMatchSettings.minimumMatchScore,
      alertsEnabled: recruiterMatchSettings.enabled,
    })
    .from(requests)
    .innerJoin(recruiterMatchSettings, eq(recruiterMatchSettings.orgId, requests.orgId))
    .where(scope.requestId ? eq(requests.id, scope.requestId) : eq(recruiterMatchSettings.enabled, true));

  const subscriptionRows = await db
    .select()
    .from(jobAlertSubscriptions)
    .where(
      scope.candidateAccountId
        ? eq(jobAlertSubscriptions.candidateAccountId, scope.candidateAccountId)
        : eq(jobAlertSubscriptions.enabled, true),
    );

  const notificationIds: string[] = [];
  const recentAlertCount = new Map<string, number>();
  for (const role of roleRows) {
    if (
      !role.alertsEnabled ||
      !role.listed ||
      !ACTIVE_STATUSES.has(role.status) ||
      (role.expiresAt && role.expiresAt <= new Date())
    ) {
      continue;
    }
    for (const subscription of subscriptionRows) {
      if (!subscription.enabled) continue;
      let recentCount = recentAlertCount.get(subscription.candidateAccountId);
      if (recentCount == null) {
        const [row] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(jobMatchNotifications)
          .where(
            and(
              eq(
                jobMatchNotifications.candidateAccountId,
                subscription.candidateAccountId,
              ),
              inArray(jobMatchNotifications.status, ["queued", "sent"]),
              gte(
                jobMatchNotifications.createdAt,
                new Date(Date.now() - 24 * 60 * 60 * 1000),
              ),
            ),
          );
        recentCount = row.count;
        recentAlertCount.set(subscription.candidateAccountId, recentCount);
      }
      if (recentCount >= MAX_ALERTS_PER_CANDIDATE_PER_DAY) continue;
      const match = evaluateJobMatch(
        role,
        subscription,
        role.minimumMatchScore,
      );
      if (!match.matches) continue;
      const [notification] = await db
        .insert(jobMatchNotifications)
        .values({
          orgId: role.orgId,
          requestId: role.id,
          candidateAccountId: subscription.candidateAccountId,
          matchScore: match.score,
          matchedSkills: match.matchedSkills,
        })
        .onConflictDoNothing()
        .returning({ id: jobMatchNotifications.id });
      if (notification) {
        notificationIds.push(notification.id);
        recentAlertCount.set(subscription.candidateAccountId, recentCount + 1);
      }
    }
  }
  return notificationIds;
}

export async function deliverJobMatch(notificationId: string) {
  const [row] = await db
    .select({
      notificationId: jobMatchNotifications.id,
      status: jobMatchNotifications.status,
      matchScore: jobMatchNotifications.matchScore,
      matchedSkills: jobMatchNotifications.matchedSkills,
      candidateAccountId: jobMatchNotifications.candidateAccountId,
      email: user.email,
      requestId: requests.id,
      requestTitle: requests.title,
      requestStatus: requests.status,
      listed: requests.listed,
      location: requests.location,
      expiresAt: requests.expiresAt,
      orgId: organisations.id,
      orgName: organisations.name,
      branding: organisations.branding,
      sendingMode: organisations.sendingMode,
      sendingDomain: organisations.sendingDomain,
      sendingDomainVerifiedAt: organisations.sendingDomainVerifiedAt,
      recruiterEnabled: recruiterMatchSettings.enabled,
      subscriberEnabled: jobAlertSubscriptions.enabled,
    })
    .from(jobMatchNotifications)
    .innerJoin(requests, eq(requests.id, jobMatchNotifications.requestId))
    .innerJoin(organisations, eq(organisations.id, jobMatchNotifications.orgId))
    .innerJoin(
      recruiterMatchSettings,
      eq(recruiterMatchSettings.orgId, jobMatchNotifications.orgId),
    )
    .innerJoin(
      jobAlertSubscriptions,
      eq(
        jobAlertSubscriptions.candidateAccountId,
        jobMatchNotifications.candidateAccountId,
      ),
    )
    .innerJoin(
      candidateAccounts,
      eq(candidateAccounts.id, jobMatchNotifications.candidateAccountId),
    )
    .innerJoin(user, eq(user.id, candidateAccounts.userId))
    .where(eq(jobMatchNotifications.id, notificationId));
  if (!row) return "missing";
  if (row.status === "sent") return "already_sent";

  const stillEligible =
    row.recruiterEnabled &&
    row.subscriberEnabled &&
    row.listed &&
    ACTIVE_STATUSES.has(row.requestStatus) &&
    (!row.expiresAt || row.expiresAt > new Date());
  if (!stillEligible) {
    await db
      .update(jobMatchNotifications)
      .set({ status: "skipped", updatedAt: new Date() })
      .where(eq(jobMatchNotifications.id, notificationId));
    return "skipped";
  }

  try {
    const providerMessageId = await sendJobMatchAlert({
      to: row.email,
      org: {
        orgName: row.orgName,
        senderName: row.branding?.senderName,
        sendingMode: row.sendingMode,
        sendingDomain: row.sendingDomain,
        sendingDomainVerifiedAt: row.sendingDomainVerifiedAt,
      },
      requestTitle: row.requestTitle,
      location: row.location,
      matchScore: row.matchScore,
      matchedSkills: row.matchedSkills,
      rolesUrl: `${process.env.APP_URL ?? "http://localhost:3000"}/roles`,
    });
    await db
      .update(jobMatchNotifications)
      .set({
        status: "sent",
        providerMessageId,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobMatchNotifications.id, notificationId));
    await audit({
      orgId: row.orgId,
      actorType: "system",
      action: "job_match.notification_sent",
      targetType: "request",
      targetId: row.requestId,
    });
    return "sent";
  } catch (error) {
    await db
      .update(jobMatchNotifications)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(jobMatchNotifications.id, notificationId));
    throw error;
  }
}
