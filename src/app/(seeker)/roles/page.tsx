import { and, desc, eq, inArray } from "drizzle-orm";
import { BellRing, ShieldCheck } from "lucide-react";
import { db } from "@/db";
import {
  accessTokens,
  discoveryProfiles,
  jobAlertSubscriptions,
  jobMatchNotifications,
  organisations,
  requests,
  savedRoles,
  submissions,
} from "@/db/schema";
import { requireCandidate } from "@/lib/guards";
import { applicationStatusLabel } from "@/lib/application-status";
import { toggleSavedRole } from "@/actions/wallet";
import { updateJobAlertSubscription } from "@/actions/job-alerts";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  statusBadgeVariant,
} from "@/components/ui";
import { formatSalaryRange, roleMetadataLabel } from "@/lib/role-metadata";

/**
 * Roles a seeker can see: requests sent to their email, roles they've
 * responded to, and roles orgs have listed for seekers they engage with.
 * Never an open job board.
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    location?: string;
    employment?: string;
    view?: string;
    minSalary?: string;
    sort?: string;
  }>;
}) {
  const ctx = await requireCandidate();

  const [subscriptionRows, profileRows, matchedNotifications] = await Promise.all([
    db
      .select()
      .from(jobAlertSubscriptions)
      .where(eq(jobAlertSubscriptions.candidateAccountId, ctx.candidateAccountId)),
    db
      .select({ skills: discoveryProfiles.skills, location: discoveryProfiles.location })
      .from(discoveryProfiles)
      .where(eq(discoveryProfiles.candidateAccountId, ctx.candidateAccountId)),
    db
      .select({
        requestId: jobMatchNotifications.requestId,
        matchScore: jobMatchNotifications.matchScore,
        matchedSkills: jobMatchNotifications.matchedSkills,
      })
      .from(jobMatchNotifications)
      .where(
        and(
          eq(jobMatchNotifications.candidateAccountId, ctx.candidateAccountId),
          eq(jobMatchNotifications.status, "sent"),
        ),
      ),
  ]);
  const subscription = subscriptionRows[0];
  const discoveryProfile = profileRows[0];
  const matchedByRequest = new Map(
    matchedNotifications.map((notification) => [notification.requestId, notification]),
  );

  const saved = await db
    .select({ requestId: savedRoles.requestId })
    .from(savedRoles)
    .where(eq(savedRoles.candidateAccountId, ctx.candidateAccountId));
  const savedIds = new Set(saved.map((s) => s.requestId));

  const responded = await db
    .select({ requestId: submissions.requestId, status: submissions.status })
    .from(submissions)
    .where(eq(submissions.candidateAccountId, ctx.candidateAccountId));
  const respondedIds = new Set(responded.map((r) => r.requestId));

  // In-progress drafts (saved, not yet submitted).
  const drafts = await db
    .select({ title: requests.title, orgName: organisations.name, updatedAt: submissions.updatedAt })
    .from(submissions)
    .innerJoin(requests, eq(requests.id, submissions.requestId))
    .innerJoin(organisations, eq(organisations.id, requests.orgId))
    .where(
      and(
        eq(submissions.candidateAccountId, ctx.candidateAccountId),
        eq(submissions.status, "started"),
      ),
    )
    .orderBy(desc(submissions.updatedAt));

  const invited = await db
    .select({ requestId: accessTokens.requestId })
    .from(accessTokens)
    .where(eq(accessTokens.recipientEmail, ctx.userEmail.toLowerCase()));
  const invitedIds = new Set(invited.map((i) => i.requestId));

  // Engaged orgs: any org that has sent this seeker a request. Listed roles
  // from those orgs are discoverable.
  const accessibleIds = new Set([
    ...savedIds,
    ...respondedIds,
    ...invitedIds,
    ...matchedByRequest.keys(),
  ]);

  const engagedOrgRows =
    accessibleIds.size > 0
      ? await db
          .select({ orgId: requests.orgId })
          .from(requests)
          .where(inArray(requests.id, [...accessibleIds]))
      : [];
  const engagedOrgIds = [...new Set(engagedOrgRows.map((r) => r.orgId))];

  const listedRows =
    engagedOrgIds.length > 0
      ? await db
          .select({ id: requests.id })
          .from(requests)
          .where(inArray(requests.orgId, engagedOrgIds))
      : [];

  const allIds = [
    ...new Set([...accessibleIds, ...listedRows.map((r) => r.id)]),
  ];

  const roles =
    allIds.length > 0
      ? await db
          .select({ request: requests, orgName: organisations.name })
          .from(requests)
          .innerJoin(organisations, eq(organisations.id, requests.orgId))
          .where(inArray(requests.id, allIds))
          .orderBy(desc(requests.createdAt))
      : [];

  const visible = roles.filter(
    (r) => accessibleIds.has(r.request.id) || r.request.listed,
  );
  const params = await searchParams;
  const query = (params.q ?? "").trim().toLowerCase();
  const locationFilter = (params.location ?? "").trim();
  const employmentFilter = (params.employment ?? "").trim();
  const viewFilter = (params.view ?? "all").trim();
  const minimumSalary = Number(params.minSalary ?? 0) || 0;
  const sort = params.sort ?? "recent";
  const locationOptions = [
    ...new Set(visible.map((role) => role.request.location).filter(Boolean)),
  ].sort((a, b) => a!.localeCompare(b!)) as string[];

  const filtered = visible.filter((role) => {
    const record = role.request;
    const haystack = `${record.title} ${record.description ?? ""} ${record.skills.join(" ")} ${role.orgName} ${record.location ?? ""}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (locationFilter && record.location !== locationFilter) return false;
    if (employmentFilter && record.employmentType !== employmentFilter) return false;
    const salaryCeiling = record.salaryMax ?? record.salaryMin ?? 0;
    if (minimumSalary > 0 && salaryCeiling < minimumSalary) return false;
    if (viewFilter === "applications" && !respondedIds.has(record.id)) return false;
    if (viewFilter === "saved" && (!savedIds.has(record.id) || respondedIds.has(record.id))) return false;
    if (
      viewFilter === "available" &&
      (savedIds.has(record.id) || respondedIds.has(record.id))
    ) {
      return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "oldest") return a.request.createdAt.getTime() - b.request.createdAt.getTime();
    if (sort === "title") return a.request.title.localeCompare(b.request.title);
    if (sort === "salary") {
      return (b.request.salaryMax ?? b.request.salaryMin ?? 0) -
        (a.request.salaryMax ?? a.request.salaryMin ?? 0);
    }
    if (sort === "closing") {
      const aClosing = a.request.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bClosing = b.request.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return aClosing - bClosing;
    }
    return b.request.createdAt.getTime() - a.request.createdAt.getTime();
  });

  const applications = sorted.filter((r) => respondedIds.has(r.request.id));
  const favourites = sorted.filter(
    (r) => savedIds.has(r.request.id) && !respondedIds.has(r.request.id),
  );
  const others = sorted.filter(
    (r) => !savedIds.has(r.request.id) && !respondedIds.has(r.request.id),
  );

  function RoleRow({ request, orgName }: { request: typeof requests.$inferSelect; orgName: string }) {
    const isSaved = savedIds.has(request.id);
    const myResponse = responded.find((x) => x.requestId === request.id);
    const alertMatch = matchedByRequest.get(request.id);
    return (
      <li className="flex flex-col justify-between gap-3 py-3.5 text-sm sm:flex-row sm:items-center">
        <div className="min-w-0">
          <div className="font-semibold text-stone-900">{request.title}</div>
          <p className="mt-1 line-clamp-2 max-w-2xl text-sm leading-5 text-stone-600">
            {request.description || "Role details are available through your secure invitation."}
          </p>
          <div className="tnum mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500">
            <span>{orgName}</span>
            {request.location && <span>{request.location}</span>}
            {request.employmentType && <span>{roleMetadataLabel(request.employmentType)}</span>}
            {request.workArrangement && <span>{roleMetadataLabel(request.workArrangement)}</span>}
            {request.skills.length > 0 && <span>{request.skills.slice(0, 4).join(" · ")}</span>}
            {formatSalaryRange(request.salaryMin, request.salaryMax, request.salaryPeriod) && (
              <span>{formatSalaryRange(request.salaryMin, request.salaryMax, request.salaryPeriod)}</span>
            )}
            {request.expiresAt && <span>Closes {request.expiresAt.toLocaleDateString("en-AU")}</span>}
            {myResponse && <span>{applicationStatusLabel(myResponse.status)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {alertMatch && <Badge variant="green">{alertMatch.matchScore}% alert match</Badge>}
          <Badge variant={statusBadgeVariant(myResponse?.status ?? request.status)}>
            {myResponse ? applicationStatusLabel(myResponse.status) : request.status.replace("_", " ")}
          </Badge>
          <ActionForm
            action={toggleSavedRole}
            successMessage={isSaved ? "Role removed from saved roles." : "Role saved."}
          >
            <input type="hidden" name="requestId" value={request.id} />
            <Button type="submit" variant={isSaved ? "secondary" : "ghost"} size="sm">
              {isSaved ? "Saved" : "Save role"}
            </Button>
          </ActionForm>
        </div>
      </li>
    );
  }

  return (
    <div className="max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-medium text-accent">Your job search</p>
        <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">Applications and roles</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500">
          Track each application from draft to placement, then save relevant roles for later.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <CardTitle className="flex items-center gap-2">
              <BellRing className="h-4 w-4 text-accent" aria-hidden />
              Matching job alerts
            </CardTitle>
            <Badge variant={subscription?.enabled ? "green" : "default"}>
              {subscription?.enabled ? "Subscribed" : "Off"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={updateJobAlertSubscription}
            successMessage="Job alert preferences saved."
            className="space-y-5"
          >
            <label className="flex items-start gap-3 rounded-md border border-stone-200 bg-stone-50/70 p-4">
              <input
                type="checkbox"
                name="enabled"
                className="mt-1"
                defaultChecked={subscription?.enabled ?? false}
              />
              <span>
                <span className="block text-sm font-semibold text-stone-900">
                  Email me when a listed role matches
                </span>
                <span className="mt-1 block text-xs leading-5 text-stone-500">
                  You stay anonymous. Recruiters do not receive your identity, profile, or
                  documents unless you choose to respond through a secure application flow.
                </span>
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="alert-skills">Skills and interests</Label>
                <Input
                  id="alert-skills"
                  name="skills"
                  placeholder="Azure, React, incident response"
                  defaultValue={(subscription?.skills ?? discoveryProfile?.skills ?? []).join(", ")}
                />
                <p className="mt-1 text-xs text-stone-500">Comma-separated. At least one is required when alerts are on.</p>
              </div>
              <div>
                <Label htmlFor="alert-locations">Preferred locations</Label>
                <Input
                  id="alert-locations"
                  name="locations"
                  placeholder="Canberra, Sydney"
                  defaultValue={(subscription?.locations ?? (discoveryProfile?.location ? [discoveryProfile.location] : [])).join(", ")}
                />
                <p className="mt-1 text-xs text-stone-500">Leave blank for any location.</p>
              </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <fieldset>
                <legend className="text-sm font-medium text-stone-700">Employment types</legend>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-stone-600">
                  {[
                    ["permanent", "Permanent"],
                    ["contract", "Contract"],
                    ["fixed_term", "Fixed term"],
                    ["casual", "Casual"],
                  ].map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="employmentTypes"
                        value={value}
                        defaultChecked={subscription?.employmentTypes.includes(value) ?? false}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="text-sm font-medium text-stone-700">Work arrangements</legend>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-stone-600">
                  {[
                    ["on_site", "On-site"],
                    ["hybrid", "Hybrid"],
                    ["remote", "Remote"],
                  ].map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="workArrangements"
                        value={value}
                        defaultChecked={subscription?.workArrangements.includes(value) ?? false}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="max-w-sm">
              <Label htmlFor="alert-minimum-salary">Minimum salary or rate</Label>
              <Input
                id="alert-minimum-salary"
                name="minimumSalary"
                type="number"
                min="0"
                step="1"
                placeholder="Any"
                defaultValue={subscription?.minimumSalary ?? ""}
              />
            </div>
            <div className="flex flex-col justify-between gap-4 border-t border-stone-100 pt-4 sm:flex-row sm:items-center">
              <div className="flex items-start gap-2 text-xs leading-5 text-stone-500">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                Alerts are deduplicated per role and capped at five in 24 hours. Turn the checkbox
                off and save to unsubscribe.
              </div>
              <Button type="submit">Save alert preferences</Button>
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <CardTitle>Find a role</CardTitle>
            <span className="text-xs text-stone-500">
              {sorted.length} {sorted.length === 1 ? "result" : "results"}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <form method="get" className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.5fr)_minmax(160px,1fr)_minmax(150px,0.8fr)]">
              <div>
                <Label htmlFor="role-search">Keyword</Label>
                <Input
                  id="role-search"
                  name="q"
                  type="search"
                  placeholder="Title, skill, or organisation"
                  defaultValue={params.q ?? ""}
                />
              </div>
              <div>
                <Label htmlFor="role-location">Location</Label>
                <Select id="role-location" name="location" defaultValue={locationFilter}>
                  <option value="">All locations</option>
                  {locationOptions.map((location) => (
                    <option key={location} value={location}>{location}</option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="role-employment">Employment</Label>
                <Select id="role-employment" name="employment" defaultValue={employmentFilter}>
                  <option value="">All types</option>
                  <option value="permanent">Permanent</option>
                  <option value="contract">Contract</option>
                  <option value="fixed_term">Fixed term</option>
                  <option value="casual">Casual</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(150px,0.8fr)_minmax(150px,0.8fr)_minmax(180px,1fr)_auto] lg:items-end">
              <div>
                <Label htmlFor="role-view">Show</Label>
                <Select id="role-view" name="view" defaultValue={viewFilter}>
                  <option value="all">All roles</option>
                  <option value="applications">Applications</option>
                  <option value="saved">Saved roles</option>
                  <option value="available">Available roles</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="role-salary">Minimum salary/rate</Label>
                <Input
                  id="role-salary"
                  name="minSalary"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Any"
                  defaultValue={params.minSalary ?? ""}
                />
              </div>
              <div>
                <Label htmlFor="role-sort">Sort by</Label>
                <Select id="role-sort" name="sort" defaultValue={sort}>
                  <option value="recent">Most recent</option>
                  <option value="oldest">Oldest</option>
                  <option value="title">Title A to Z</option>
                  <option value="salary">Salary/rate, high to low</option>
                  <option value="closing">Closing soon</option>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button type="submit">Apply filters</Button>
                <ButtonLink href="/roles" variant="ghost">Reset</ButtonLink>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Drafts in progress</CardTitle>
              <Badge variant="amber">{drafts.length} to finish</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-stone-100">
              {drafts.map((d, i) => (
                <li key={i} className="flex flex-col justify-between gap-3 py-3 text-sm sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-stone-800">{d.title}</div>
                    <div className="tnum text-stone-500">
                      {d.orgName} · saved {new Date(d.updatedAt).toLocaleDateString("en-AU")}
                    </div>
                  </div>
                  <Badge variant="amber">draft</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-stone-500">
              Reopen the secure link we emailed you to finish and submit a draft before
              it expires.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Applications</CardTitle>
            <Badge>{applications.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {applications.length === 0 ? (
            <p className="text-sm text-stone-500">
              You haven&apos;t submitted an application yet. Invited and available roles appear below.
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {applications.map((r) => (
                <RoleRow key={r.request.id} request={r.request} orgName={r.orgName} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Saved roles</CardTitle>
            <Badge>{favourites.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {favourites.length === 0 ? (
            <p className="text-sm text-stone-500">No favourites yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {favourites.map((r) => (
                <RoleRow key={r.request.id} request={r.request} orgName={r.orgName} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Available to you</CardTitle>
            <Badge>{others.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {others.length === 0 ? (
            <p className="text-sm text-stone-500">Nothing else right now.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {others.map((r) => (
                <RoleRow key={r.request.id} request={r.request} orgName={r.orgName} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
