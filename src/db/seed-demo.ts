/**
 * Seed screenshot-ready demo data for one existing recruiter and job seeker.
 *
 * The command is idempotent for the named demo roles and never creates users,
 * credentials, identity documents, police checks, or other sensitive PII.
 *
 * Run:
 *   npm run db:seed-demo -- --recruiter owner@example.com --seeker seeker@example.com
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./index";
import {
  accessTokens,
  candidateAccounts,
  deliveries,
  discoveryProfiles,
  jobAlertSubscriptions,
  jobMatchNotifications,
  memberships,
  organisations,
  recruiterMatchSettings,
  requestFields,
  requests,
  savedRoles,
  submissions,
  user,
} from "./schema";
import { fieldDefinition } from "@/lib/fields";
import { evaluateJobMatch } from "@/lib/job-match-rules";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim().toLowerCase() : "";
  if (!value) throw new Error(`Missing --${name} email address.`);
  return value;
}

function daysFromNow(days: number): Date {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value;
}

const roleSeeds = [
  {
    title: "Senior Cyber Security Analyst",
    description:
      "Lead threat detection, incident response, and security uplift for a major Australian government program.",
    location: "Canberra, ACT",
    employmentType: "contract",
    workArrangement: "hybrid",
    salaryMin: 1_200,
    salaryMax: 1_400,
    salaryPeriod: "daily",
    skills: ["Microsoft Sentinel", "Incident response", "Threat hunting", "Azure"],
    status: "open" as const,
    expiresInDays: 18,
    createdDaysAgo: 2,
    fields: ["clearance_level", "clearance_id", "resume", "cover_letter"],
    stages: [
      "received",
      "under_review",
      "shortlisted",
      "interview",
      "offer",
      "placed",
      "follow_up",
      "declined",
    ] as const,
  },
  {
    title: "Cloud Platform Engineer",
    description:
      "Build secure Azure landing zones, deployment pipelines, and reliable cloud platforms for regulated workloads.",
    location: "Sydney, NSW",
    employmentType: "permanent",
    workArrangement: "hybrid",
    salaryMin: 155_000,
    salaryMax: 180_000,
    salaryPeriod: "annual",
    skills: ["Azure", "Terraform", "Docker", "GitHub Actions"],
    status: "open" as const,
    expiresInDays: 28,
    createdDaysAgo: 9,
    fields: ["clearance_level", "resume", "cover_letter"],
    stages: ["received", "under_review", "shortlisted", "interview", "offer", "accepted"] as const,
  },
  {
    title: "Security Cleared Project Manager",
    description:
      "Coordinate delivery across security, infrastructure, and business teams on a complex transformation program.",
    location: "Canberra, ACT",
    employmentType: "contract",
    workArrangement: "on_site",
    salaryMin: 1_300,
    salaryMax: 1_550,
    salaryPeriod: "daily",
    skills: ["Program delivery", "Risk management", "Stakeholder management"],
    status: "closing_soon" as const,
    expiresInDays: 7,
    createdDaysAgo: 16,
    fields: ["clearance_level", "clearance_id", "resume", "cover_letter"],
    stages: ["received", "follow_up", "shortlisted", "interview", "declined"] as const,
  },
  {
    title: "SOC Analyst",
    description:
      "Investigate security alerts, tune detections, and work with engineering teams to improve response maturity.",
    location: "Melbourne, VIC",
    employmentType: "permanent",
    workArrangement: "hybrid",
    salaryMin: 120_000,
    salaryMax: 145_000,
    salaryPeriod: "annual",
    skills: ["Microsoft Sentinel", "SIEM", "Incident response", "EDR"],
    status: "open" as const,
    expiresInDays: 35,
    createdDaysAgo: 23,
    fields: ["resume", "cover_letter"],
    stages: ["received", "under_review", "shortlisted", "interview", "offer"] as const,
  },
  {
    title: "DevSecOps Engineer",
    description:
      "Embed security controls into CI/CD, container platforms, and infrastructure-as-code delivery practices.",
    location: "Brisbane, QLD",
    employmentType: "permanent",
    workArrangement: "remote",
    salaryMin: 160_000,
    salaryMax: 190_000,
    salaryPeriod: "annual",
    skills: ["Docker", "Kubernetes", "GitHub Actions", "Infrastructure as code"],
    status: "closed" as const,
    expiresInDays: -4,
    createdDaysAgo: 31,
    fields: ["clearance_level", "resume", "cover_letter"],
    stages: ["placed", "placed", "accepted", "declined"] as const,
  },
  {
    title: "Governance, Risk & Compliance Consultant",
    description:
      "Help clients translate security obligations into pragmatic controls, evidence, and improvement roadmaps.",
    location: "Canberra, ACT",
    employmentType: "contract",
    workArrangement: "hybrid",
    salaryMin: 1_050,
    salaryMax: 1_250,
    salaryPeriod: "daily",
    skills: ["IRAP", "Australian ISM", "Risk assessment", "Security governance"],
    status: "open" as const,
    expiresInDays: 42,
    createdDaysAgo: 38,
    fields: ["clearance_level", "resume", "cover_letter"],
    stages: ["received", "under_review", "shortlisted"] as const,
  },
] as const;

async function main() {
  const recruiterEmail = argument("recruiter");
  const seekerEmail = argument("seeker");

  const [recruiter] = await db
    .select({
      userId: user.id,
      orgId: organisations.id,
      orgName: organisations.name,
      role: memberships.role,
    })
    .from(user)
    .innerJoin(memberships, eq(memberships.userId, user.id))
    .innerJoin(organisations, eq(organisations.id, memberships.orgId))
    .where(eq(user.email, recruiterEmail))
    .limit(1);
  if (!recruiter) throw new Error("Recruiter account or organisation membership not found.");
  if (!(["owner", "admin", "recruiter"] as string[]).includes(recruiter.role)) {
    throw new Error("The selected account cannot own recruiter demo roles.");
  }

  const [seeker] = await db
    .select({
      userId: user.id,
      candidateAccountId: candidateAccounts.id,
    })
    .from(user)
    .innerJoin(candidateAccounts, eq(candidateAccounts.userId, user.id))
    .where(eq(user.email, seekerEmail))
    .limit(1);
  if (!seeker) throw new Error("Job-seeker account not found.");

  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(
        and(
          eq(requests.orgId, recruiter.orgId),
          inArray(
            requests.title,
            roleSeeds.map((role) => role.title),
          ),
        ),
      );
    if (existing.length) {
      await tx.delete(requests).where(inArray(requests.id, existing.map((role) => role.id)));
    }

    const seededRequests: { id: string; title: string }[] = [];
    let submissionCount = 0;

    for (const [roleIndex, role] of roleSeeds.entries()) {
      const [request] = await tx
        .insert(requests)
        .values({
          orgId: recruiter.orgId,
          createdBy: recruiter.userId,
          title: role.title,
          description: role.description,
          location: role.location,
          employmentType: role.employmentType,
          workArrangement: role.workArrangement,
          salaryMin: role.salaryMin,
          salaryMax: role.salaryMax,
          salaryPeriod: role.salaryPeriod,
          skills: [...role.skills],
          status: role.status,
          listed: role.status !== "closed",
          expiresAt: daysFromNow(role.expiresInDays),
          closedAt: role.status === "closed" ? daysFromNow(-4) : null,
          consentRequired: true,
          consentPurpose: "Assess suitability for this role and manage the placement process.",
          createdAt: daysFromNow(-role.createdDaysAgo),
        })
        .returning({ id: requests.id, title: requests.title });
      seededRequests.push(request);

      const fields = role.fields
        .map((key, sortOrder) => ({ definition: fieldDefinition(key), sortOrder }))
        .filter((entry) => entry.definition);
      await tx.insert(requestFields).values(
        fields.map(({ definition, sortOrder }) => ({
          requestId: request.id,
          key: definition!.key,
          type: definition!.type,
          label: definition!.label,
          helpText: definition!.helpText,
          required: true,
          sensitive: definition!.sensitive,
          sortOrder,
        })),
      );

      for (const [stageIndex, status] of role.stages.entries()) {
        const createdDaysAgo = Math.max(role.createdDaysAgo - stageIndex * 3, 0);
        const linkedSeeker = roleIndex < 5 && stageIndex === 0;
        await tx.insert(submissions).values({
          requestId: request.id,
          candidateAccountId: linkedSeeker ? seeker.candidateAccountId : null,
          responderEmail: linkedSeeker
            ? seekerEmail
            : `candidate-${roleIndex + 1}-${stageIndex + 1}@example.test`,
          status,
          submittedAt: daysFromNow(-createdDaysAgo),
          createdAt: daysFromNow(-createdDaysAgo),
          updatedAt: daysFromNow(-Math.max(createdDaysAgo - 2, 0)),
        });
        submissionCount += 1;
      }

      const invitationCount = role.status === "closed" ? 0 : roleIndex % 2 === 0 ? 2 : 1;
      for (let invitationIndex = 0; invitationIndex < invitationCount; invitationIndex += 1) {
        const createdAt = daysFromNow(-(roleIndex * 2 + invitationIndex + 1));
        const [invitation] = await tx
          .insert(accessTokens)
          .values({
            requestId: request.id,
            tokenHash: createHash("sha256")
              .update(`demo-invitation:${request.id}:${invitationIndex}`)
              .digest("hex"),
            recipientEmail: `pending-${roleIndex + 1}-${invitationIndex + 1}@example.test`,
            expiresAt: daysFromNow(10 + invitationIndex),
            createdAt,
          })
          .returning({ id: accessTokens.id });
        await tx.insert(deliveries).values({
          requestId: request.id,
          accessTokenId: invitation.id,
          channel: "email",
          recipient: `pending-${roleIndex + 1}-${invitationIndex + 1}@example.test`,
          status: invitationIndex % 2 === 0 ? "opened" : "sent",
          createdAt,
          updatedAt: createdAt,
        });
      }
    }

    await tx
      .insert(discoveryProfiles)
      .values({
        candidateAccountId: seeker.candidateAccountId,
        handle: `candidate_${createHash("sha256").update(seeker.userId).digest("hex").slice(0, 16)}`,
        discoverable: true,
        clearanceLevel: "nv1",
        skills: [
          "Azure",
          "TypeScript",
          "React",
          "Docker",
          "GitHub Actions",
          "Microsoft Sentinel",
          "Cybersecurity",
        ],
        location: "Canberra, ACT",
      })
      .onConflictDoNothing();

    await tx
      .insert(savedRoles)
      .values(
        seededRequests.slice(1, 3).map((request) => ({
          candidateAccountId: seeker.candidateAccountId,
          requestId: request.id,
        })),
      )
      .onConflictDoNothing();

    const alertPreferences = {
      skills: ["Azure", "Docker", "GitHub Actions", "Microsoft Sentinel"],
      locations: [] as string[],
      employmentTypes: [] as string[],
      workArrangements: [] as string[],
      minimumSalary: null,
    };
    await tx
      .insert(recruiterMatchSettings)
      .values({
        orgId: recruiter.orgId,
        enabled: true,
        minimumMatchScore: 50,
        updatedBy: recruiter.userId,
      })
      .onConflictDoUpdate({
        target: recruiterMatchSettings.orgId,
        set: { enabled: true, minimumMatchScore: 50, updatedBy: recruiter.userId },
      });
    await tx
      .insert(jobAlertSubscriptions)
      .values({
        candidateAccountId: seeker.candidateAccountId,
        enabled: true,
        ...alertPreferences,
      })
      .onConflictDoUpdate({
        target: jobAlertSubscriptions.candidateAccountId,
        set: { enabled: true, ...alertPreferences, updatedAt: new Date() },
      });

    for (const [index, request] of seededRequests.entries()) {
      const role = roleSeeds[index];
      if (role.status === "closed") continue;
      const match = evaluateJobMatch(role, alertPreferences, 50);
      if (!match.matches) continue;
      await tx
        .insert(jobMatchNotifications)
        .values({
          orgId: recruiter.orgId,
          requestId: request.id,
          candidateAccountId: seeker.candidateAccountId,
          matchScore: match.score,
          matchedSkills: match.matchedSkills,
          status: "sent",
          sentAt: daysFromNow(-Math.min(index + 1, 5)),
        })
        .onConflictDoNothing();
    }

    return { roleCount: seededRequests.length, submissionCount };
  });

  console.log(
    `Seeded ${result.roleCount} demo roles and ${result.submissionCount} applications for ${recruiter.orgName}.`,
  );
  console.log("No documents, identity data, police checks, or credentials were created.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
