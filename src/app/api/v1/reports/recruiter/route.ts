import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accessTokens,
  deliveries,
  jobMatchNotifications,
  requests,
  submissions,
} from "@/db/schema";
import { resolveOrgContext } from "@/lib/api-auth";
import { handle, json } from "@/lib/api/http";

const ACTIVE_ROLE_STATUSES = new Set(["open", "closing_soon"]);
const RECRUITER_ACTION_STATUSES = new Set(["received", "follow_up"]);
const DAY_MS = 86_400_000;

const stageRank: Record<string, number> = {
  started: 0,
  received: 1,
  under_review: 2,
  follow_up: 2,
  shortlisted: 3,
  interview: 4,
  offer: 5,
  accepted: 6,
  placed: 7,
  declined: -1,
  withdrawn: -1,
};

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function startOfPreviousCalendarMonth(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

function startOfCurrentCalendarMonth(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function groupByStatus<T extends { status: string }>(rows: T[]): Record<string, T[]> {
  return rows.reduce<Record<string, T[]>>((groups, row) => {
    (groups[row.status] ??= []).push(row);
    return groups;
  }, {});
}

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await resolveOrgContext(req, "requests:create");
    const now = new Date();
    const previousMonthStart = startOfPreviousCalendarMonth(now);
    const currentMonthStart = startOfCurrentCalendarMonth(now);
    const nextSevenDays = new Date(now.getTime() + 7 * DAY_MS);
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

    const [roleRows, submissionRows, invitationRows, matchNotificationRows] = await Promise.all([
      db
        .select({
          id: requests.id,
          title: requests.title,
          status: requests.status,
          location: requests.location,
          expiresAt: requests.expiresAt,
          createdAt: requests.createdAt,
        })
        .from(requests)
        .where(eq(requests.orgId, ctx.orgId)),
      db
        .select({
          id: submissions.id,
          requestId: submissions.requestId,
          candidateAccountId: submissions.candidateAccountId,
          status: submissions.status,
          submittedAt: submissions.submittedAt,
          createdAt: submissions.createdAt,
          updatedAt: submissions.updatedAt,
        })
        .from(submissions)
        .innerJoin(requests, eq(requests.id, submissions.requestId))
        .where(eq(requests.orgId, ctx.orgId)),
      db
        .select({
          id: accessTokens.id,
          requestId: accessTokens.requestId,
          requestTitle: requests.title,
          createdAt: accessTokens.createdAt,
          expiresAt: accessTokens.expiresAt,
          revokedAt: accessTokens.revokedAt,
          consumedAt: accessTokens.consumedAt,
          deliveryStatus: deliveries.status,
          submissionId: submissions.id,
          submissionStatus: submissions.status,
        })
        .from(accessTokens)
        .innerJoin(requests, eq(requests.id, accessTokens.requestId))
        .leftJoin(deliveries, eq(deliveries.accessTokenId, accessTokens.id))
        .leftJoin(submissions, eq(submissions.accessTokenId, accessTokens.id))
        .where(eq(requests.orgId, ctx.orgId)),
      db
        .select({
          requestId: jobMatchNotifications.requestId,
          candidateAccountId: jobMatchNotifications.candidateAccountId,
          status: jobMatchNotifications.status,
          sentAt: jobMatchNotifications.sentAt,
          createdAt: jobMatchNotifications.createdAt,
        })
        .from(jobMatchNotifications)
        .where(eq(jobMatchNotifications.orgId, ctx.orgId)),
    ]);

    const roleIds = new Set(roleRows.map((role) => role.id));
    const visibleSubmissions = submissionRows.filter((submission) => roleIds.has(submission.requestId));
    const submissionsByRole = new Map<string, typeof visibleSubmissions>();
    for (const submission of visibleSubmissions) {
      const rows = submissionsByRole.get(submission.requestId) ?? [];
      rows.push(submission);
      submissionsByRole.set(submission.requestId, rows);
    }

    const pendingInvitationMap = new Map<string, (typeof invitationRows)[number]>();
    for (const invitation of invitationRows) {
      const awaitingResponse =
        !invitation.revokedAt &&
        !invitation.consumedAt &&
        invitation.expiresAt > now &&
        (!invitation.submissionId || invitation.submissionStatus === "started");
      if (awaitingResponse) pendingInvitationMap.set(invitation.id, invitation);
    }
    const pendingInvitations = [...pendingInvitationMap.values()];

    const rolePipeline = roleRows.map((role) => {
      const roleSubmissions = submissionsByRole.get(role.id) ?? [];
      const stageCounts = Object.fromEntries(
        [...new Set(roleSubmissions.map((submission) => submission.status))].map((status) => [
          status,
          roleSubmissions.filter((submission) => submission.status === status).length,
        ]),
      );
      const completedApplications = roleSubmissions.filter((submission) => submission.status !== "started");
      const applicationDates = completedApplications.map(
        (submission) => submission.submittedAt ?? submission.createdAt,
      );
      const lastApplicationAt = applicationDates.sort((a, b) => b.getTime() - a.getTime())[0];
      const applicationsPreviousMonth = completedApplications.filter((submission) => {
        const date = submission.submittedAt ?? submission.createdAt;
        return date >= previousMonthStart && date < currentMonthStart;
      }).length;
      const applicationsLast30Days = completedApplications.filter((submission) => {
        const date = submission.submittedAt ?? submission.createdAt;
        return date >= thirtyDaysAgo;
      }).length;
      const roleAgeDays = Math.max((now.getTime() - role.createdAt.getTime()) / DAY_MS, 1);
      const stalledCandidates = roleSubmissions.filter(
        (submission) =>
          !["placed", "declined", "withdrawn"].includes(submission.status) &&
          submission.updatedAt < sevenDaysAgo,
      ).length;
      const highestStage = roleSubmissions
        .map((submission) => submission.status)
        .sort((a, b) => (stageRank[b] ?? 0) - (stageRank[a] ?? 0))[0] ?? null;

      return {
        roleId: role.id,
        title: role.title,
        location: role.location,
        status: role.status,
        expiresAt: iso(role.expiresAt),
        isActive: ACTIVE_ROLE_STATUSES.has(role.status),
        isFilled: roleSubmissions.some((submission) => submission.status === "placed"),
        totalApplications: completedApplications.length,
        applicationsPreviousMonth,
        applicationsLast30Days,
        applicationsPerWeekSinceCreated: Number(
          (completedApplications.length / Math.max(roleAgeDays / 7, 1)).toFixed(1),
        ),
        daysOpen: Math.floor(roleAgeDays),
        daysSinceLastApplication: lastApplicationAt
          ? Math.floor((now.getTime() - lastApplicationAt.getTime()) / DAY_MS)
          : null,
        stalledCandidates,
        awaitingRecruiterAction: roleSubmissions.filter((submission) =>
          RECRUITER_ACTION_STATUSES.has(submission.status),
        ).length,
        awaitingCandidateInformation: pendingInvitations.filter(
          (invitation) => invitation.requestId === role.id,
        ).length,
        highestPipelineStage: highestStage,
        lastApplicationAt: iso(lastApplicationAt),
        stageCounts,
      };
    });

    const activeRoles = rolePipeline.filter((role) => role.isActive);
    const unfilledActiveRoles = activeRoles.filter((role) => !role.isFilled);
    const outstandingPreviousMonth = unfilledActiveRoles.filter(
      (role) => role.applicationsPreviousMonth > 0,
    );
    const candidatesNeedingAction = visibleSubmissions.filter((submission) =>
      RECRUITER_ACTION_STATUSES.has(submission.status),
    ).length;
    const applicationsPreviousMonth = rolePipeline.reduce(
      (total, role) => total + role.applicationsPreviousMonth,
      0,
    );
    const activePipeline = visibleSubmissions.filter(
      (submission) => !["started", "placed", "declined", "withdrawn"].includes(submission.status),
    );
    const activePipelineByStatus = groupByStatus(activePipeline);
    const stageAging = Object.entries(activePipelineByStatus).map(([status, rows]) => {
      const ages = rows.map((submission) =>
        Math.max((now.getTime() - submission.updatedAt.getTime()) / DAY_MS, 0),
      );
      return {
        status,
        count: ages.length,
        averageDaysInCurrentStage: Number(
          (ages.reduce((total, age) => total + age, 0) / Math.max(ages.length, 1)).toFixed(1),
        ),
        oldestDaysInCurrentStage: Number(Math.max(...ages, 0).toFixed(1)),
        staleOverSevenDays: ages.filter((age) => age >= 7).length,
      };
    });
    const applicationsLastSevenDays = visibleSubmissions.filter((submission) => {
      const date = submission.submittedAt ?? submission.createdAt;
      return submission.status !== "started" && date >= sevenDaysAgo;
    }).length;
    const applicationsLast30Days = visibleSubmissions.filter((submission) => {
      const date = submission.submittedAt ?? submission.createdAt;
      return submission.status !== "started" && date >= thirtyDaysAgo;
    }).length;
    const stalledCandidates = rolePipeline.reduce(
      (total, role) => total + role.stalledCandidates,
      0,
    );
    const sentMatchNotifications = matchNotificationRows.filter(
      (notification) => notification.status === "sent",
    );
    const applicationsAfterMatchAlert = sentMatchNotifications.filter((notification) =>
      visibleSubmissions.some(
        (submission) =>
          submission.requestId === notification.requestId &&
          submission.candidateAccountId === notification.candidateAccountId &&
          submission.status !== "started" &&
          (submission.submittedAt ?? submission.createdAt) >=
            (notification.sentAt ?? notification.createdAt),
      ),
    ).length;

    const priorities: Array<{
      severity: "urgent" | "high" | "medium";
      type: string;
      title: string;
      detail: string;
      roleId?: string;
      dueAt?: string | null;
      count?: number;
    }> = [];

    for (const role of unfilledActiveRoles) {
      const expiry = role.expiresAt ? new Date(role.expiresAt) : null;
      if (expiry && expiry >= now && expiry <= nextSevenDays) {
        priorities.push({
          severity: "urgent",
          type: "role_closing",
          title: `${role.title} is closing soon`,
          detail: `${role.totalApplications} applications; highest stage is ${role.highestPipelineStage ?? "none"}.`,
          roleId: role.roleId,
          dueAt: role.expiresAt,
          count: role.totalApplications,
        });
      }
      if (role.awaitingRecruiterAction > 0) {
        priorities.push({
          severity: "high",
          type: "candidate_review",
          title: `Review candidates for ${role.title}`,
          detail: `${role.awaitingRecruiterAction} candidate${role.awaitingRecruiterAction === 1 ? "" : "s"} received or awaiting follow-up.`,
          roleId: role.roleId,
          count: role.awaitingRecruiterAction,
        });
      }
      if (role.stalledCandidates > 0) {
        priorities.push({
          severity: "high",
          type: "candidate_stalled",
          title: `Unblock stalled candidates for ${role.title}`,
          detail: `${role.stalledCandidates} active candidate${role.stalledCandidates === 1 ? " has" : "s have"} remained in the same stage for more than seven days.`,
          roleId: role.roleId,
          count: role.stalledCandidates,
        });
      }
      const offerOrAccepted =
        (role.stageCounts.offer ?? 0) + (role.stageCounts.accepted ?? 0);
      if (offerOrAccepted > 0) {
        priorities.push({
          severity: "high",
          type: "offer_progression",
          title: `Progress offer-stage candidates for ${role.title}`,
          detail: `${offerOrAccepted} candidate${offerOrAccepted === 1 ? " is" : "s are"} at offer or accepted stage but not yet placed.`,
          roleId: role.roleId,
          count: offerOrAccepted,
        });
      }
      if (role.awaitingCandidateInformation > 0) {
        priorities.push({
          severity: "medium",
          type: "candidate_information",
          title: `Follow up outstanding information for ${role.title}`,
          detail: `${role.awaitingCandidateInformation} active invitation${role.awaitingCandidateInformation === 1 ? " has" : "s have"} not produced a completed response.`,
          roleId: role.roleId,
          count: role.awaitingCandidateInformation,
        });
      }
      if (!role.lastApplicationAt || new Date(role.lastApplicationAt) < fourteenDaysAgo) {
        priorities.push({
          severity: "medium",
          type: "pipeline_stale",
          title: `Refresh sourcing for ${role.title}`,
          detail: "No completed application has been received in the last 14 days.",
          roleId: role.roleId,
        });
      }
    }

    const severityOrder = { urgent: 0, high: 1, medium: 2 };
    priorities.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return json({
      generatedAt: now.toISOString(),
      organisation: { name: ctx.orgName },
      periods: {
        previousCalendarMonth: {
          from: previousMonthStart.toISOString(),
          toExclusive: currentMonthStart.toISOString(),
        },
        priorityHorizon: { from: now.toISOString(), to: nextSevenDays.toISOString() },
      },
      summary: {
        activeRoles: activeRoles.length,
        unfilledActiveRoles: unfilledActiveRoles.length,
        totalApplications: visibleSubmissions.filter((submission) => submission.status !== "started").length,
        applicationsPreviousCalendarMonth: applicationsPreviousMonth,
        rolesAppliedToPreviousMonthStillUnfilled: outstandingPreviousMonth.length,
        jobSeekersAwaitingInformation: pendingInvitations.length,
        candidatesNeedingRecruiterAction: candidatesNeedingAction,
        stalledCandidatesOverSevenDays: stalledCandidates,
        applicationsLastSevenDays,
        applicationsLast30Days,
        interviewsInPipeline: visibleSubmissions.filter((submission) => submission.status === "interview").length,
        offersAwaitingOutcome: visibleSubmissions.filter((submission) =>
          ["offer", "accepted"].includes(submission.status),
        ).length,
        placements: visibleSubmissions.filter((submission) => submission.status === "placed").length,
        matchedRoleAlertsSent: sentMatchNotifications.length,
        applicationsAfterMatchedRoleAlert: applicationsAfterMatchAlert,
      },
      pipelineHealth: {
        stageAging,
        applicationVelocity: {
          lastSevenDays: applicationsLastSevenDays,
          last30Days: applicationsLast30Days,
          averagePerActiveRoleLast30Days: Number(
            (applicationsLast30Days / Math.max(activeRoles.length, 1)).toFixed(1),
          ),
          activeRolesWithoutApplicationsIn14Days: activeRoles.filter(
            (role) => role.daysSinceLastApplication == null || role.daysSinceLastApplication >= 14,
          ).length,
        },
        currentStageDistribution: Object.fromEntries(
          Object.entries(activePipelineByStatus).map(
            ([status, rows]) => [status, rows.length],
          ),
        ),
      },
      matchedRoleAlerts: {
        sent: sentMatchNotifications.length,
        queued: matchNotificationRows.filter((notification) => notification.status === "queued").length,
        failed: matchNotificationRows.filter((notification) => notification.status === "failed").length,
        skipped: matchNotificationRows.filter((notification) => notification.status === "skipped").length,
        rolesNotified: new Set(sentMatchNotifications.map((notification) => notification.requestId)).size,
        applicationsObservedAfterAlert: applicationsAfterMatchAlert,
        observedApplicationRate:
          sentMatchNotifications.length > 0
            ? Number(((applicationsAfterMatchAlert / sentMatchNotifications.length) * 100).toFixed(1))
            : 0,
      },
      previousMonthOutstandingRoles: outstandingPreviousMonth,
      awaitingInformationByRole: activeRoles
        .filter((role) => role.awaitingCandidateInformation > 0)
        .map((role) => ({
          roleId: role.roleId,
          title: role.title,
          count: role.awaitingCandidateInformation,
        })),
      priorities,
      rolePipeline,
      definitions: {
        jobSeekersAwaitingInformation:
          "Unexpired, unrevoked invitations that have not produced a completed response.",
        candidatesNeedingRecruiterAction:
          "Applications in received or follow-up status.",
        rolesAppliedToPreviousMonthStillUnfilled:
          "Active roles with at least one completed application during the previous calendar month and no placed candidate.",
        stalledCandidatesOverSevenDays:
          "Active applications whose current stage has not changed for at least seven days. Current-stage age uses the submission's last status update.",
        applicationVelocity:
          "Completed applications received during rolling 7-day and 30-day windows. This is volume, not source attribution.",
        applicationsObservedAfterAlert:
          "A completed application for the same job seeker and role after a matched-role email was sent. This is an observed association, not proof that the email caused the application.",
      },
    });
  });
}
