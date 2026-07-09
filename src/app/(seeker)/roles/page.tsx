import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  accessTokens,
  organisations,
  requests,
  savedRoles,
  submissions,
} from "@/db/schema";
import { requireCandidate } from "@/lib/guards";
import { toggleSavedRole } from "@/actions/wallet";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  statusBadgeVariant,
} from "@/components/ui";

/**
 * Roles a seeker can see: requests sent to their email, roles they've
 * responded to, and roles orgs have listed for seekers they engage with.
 * Never an open job board.
 */
export default async function RolesPage() {
  const ctx = await requireCandidate();

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

  const invited = await db
    .select({ requestId: accessTokens.requestId })
    .from(accessTokens)
    .where(eq(accessTokens.recipientEmail, ctx.userEmail.toLowerCase()));
  const invitedIds = new Set(invited.map((i) => i.requestId));

  // Engaged orgs: any org that has sent this seeker a request. Listed roles
  // from those orgs are discoverable.
  const accessibleIds = new Set([...savedIds, ...respondedIds, ...invitedIds]);

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
  const favourites = visible.filter((r) => savedIds.has(r.request.id));
  const others = visible.filter((r) => !savedIds.has(r.request.id));

  function RoleRow({ request, orgName }: { request: typeof requests.$inferSelect; orgName: string }) {
    const isSaved = savedIds.has(request.id);
    const myResponse = responded.find((x) => x.requestId === request.id);
    return (
      <li className="flex items-center justify-between gap-3 py-3 text-sm">
        <div>
          <div className="font-medium">{request.title}</div>
          <div className="text-zinc-500">
            {orgName}
            {request.expiresAt && ` · closes ${request.expiresAt.toLocaleDateString("en-AU")}`}
            {myResponse && ` · you responded (${myResponse.status.replace("_", " ")})`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusBadgeVariant(request.status)}>
            {request.status.replace("_", " ")}
          </Badge>
          <ActionForm action={toggleSavedRole}>
            <input type="hidden" name="requestId" value={request.id} />
            <Button type="submit" variant={isSaved ? "secondary" : "ghost"} size="sm">
              {isSaved ? "★ Saved" : "☆ Save"}
            </Button>
          </ActionForm>
        </div>
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My roles</h1>
        <p className="text-sm text-zinc-500">
          Roles shared with you, roles you&apos;ve responded to, and roles listed by
          organisations you&apos;ve engaged with.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Favourites</CardTitle>
        </CardHeader>
        <CardContent>
          {favourites.length === 0 ? (
            <p className="text-sm text-zinc-500">No favourites yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {favourites.map((r) => (
                <RoleRow key={r.request.id} request={r.request} orgName={r.orgName} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Available to you</CardTitle>
        </CardHeader>
        <CardContent>
          {others.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing else right now.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
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
