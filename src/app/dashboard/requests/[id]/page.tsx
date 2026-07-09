import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, deliveries, requestFields, requests, submissions } from "@/db/schema";
import { requireOrgUser } from "@/lib/guards";
import { can } from "@/lib/rbac";
import { revokeAccessToken, sendRequest, setRequestStatus } from "@/actions/requests";
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

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgUser();

  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), eq(requests.orgId, ctx.orgId)));
  if (!request) notFound();

  if (!can(ctx.role, "submissions:view_all") && request.createdBy !== ctx.userId) {
    notFound();
  }

  const fields = await db
    .select()
    .from(requestFields)
    .where(eq(requestFields.requestId, id))
    .orderBy(requestFields.sortOrder);

  const subs = await db
    .select()
    .from(submissions)
    .where(eq(submissions.requestId, id))
    .orderBy(desc(submissions.createdAt));

  const dels = await db
    .select()
    .from(deliveries)
    .where(eq(deliveries.requestId, id))
    .orderBy(desc(deliveries.createdAt));

  const tokenIds = [...new Set(dels.map((d) => d.accessTokenId))];
  const tokens = tokenIds.length
    ? await db
        .select({
          id: accessTokens.id,
          revokedAt: accessTokens.revokedAt,
          consumedAt: accessTokens.consumedAt,
        })
        .from(accessTokens)
        .where(inArray(accessTokens.id, tokenIds))
    : [];
  const tokenState = new Map(tokens.map((t) => [t.id, t]));

  const canSend = can(ctx.role, "requests:create");
  const canExport = can(ctx.role, "export:data");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{request.title}</h1>
          <p className="text-sm text-zinc-500">
            {request.expiresAt && `Expires ${request.expiresAt.toLocaleDateString("en-AU")} · `}
            {request.listed ? "Listed" : "Private (link-only)"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusBadgeVariant(request.status)}>
            {request.status.replace("_", " ")}
          </Badge>
          {canExport && (
            <>
              <a href={`/api/requests/${id}/export?format=csv`}>
                <Button variant="secondary" size="sm">
                  Export CSV
                </Button>
              </a>
              <a href={`/api/requests/${id}/export?format=json`}>
                <Button variant="secondary" size="sm">
                  Export JSON
                </Button>
              </a>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Requested fields</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {fields.map((f) => (
                <li key={f.id} className="flex items-center gap-2">
                  <span>{f.label}</span>
                  {f.sensitive && <Badge variant="amber">PII · encrypted</Badge>}
                  {f.required && <span className="text-xs text-zinc-400">required</span>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {canSend && (
          <Card>
            <CardHeader>
              <CardTitle>Send secure link</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ActionForm
                action={sendRequest}
                successMessage="Queued — the secure link is on its way."
                resetOnSuccess
                className="space-y-3"
              >
                <input type="hidden" name="requestId" value={request.id} />
                <div>
                  <Label htmlFor="recipientEmail">Candidate email</Label>
                  <Input id="recipientEmail" name="recipientEmail" type="email" required />
                </div>
                <div>
                  <Label htmlFor="recipientPhone">Mobile (optional, E.164 for SMS)</Label>
                  <Input id="recipientPhone" name="recipientPhone" placeholder="+61400000000" />
                </div>
                <Button type="submit">Send</Button>
              </ActionForm>
              <ActionForm action={setRequestStatus} className="flex items-end gap-2">
                <input type="hidden" name="requestId" value={request.id} />
                <div className="flex-1">
                  <Label htmlFor="status">Status</Label>
                  <Select id="status" name="status" defaultValue={request.status}>
                    <option value="open">Open</option>
                    <option value="closing_soon">Closing soon</option>
                    <option value="closed">Closed</option>
                    <option value="archived">Archived</option>
                  </Select>
                </div>
                <Button type="submit" variant="secondary">
                  Update
                </Button>
              </ActionForm>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deliveries</CardTitle>
        </CardHeader>
        <CardContent>
          {dels.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 text-sm">
              {dels.map((d) => {
                const tok = tokenState.get(d.accessTokenId);
                const revoked = !!tok?.revokedAt;
                const canRevoke =
                  canSend && d.channel === "email" && !revoked && !tok?.consumedAt;
                return (
                  <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                    <span>
                      {d.recipient} <span className="text-zinc-400">({d.channel})</span>
                    </span>
                    <div className="flex items-center gap-2">
                      {revoked ? (
                        <Badge variant="red">revoked</Badge>
                      ) : (
                        <Badge variant={statusBadgeVariant(d.status)}>{d.status}</Badge>
                      )}
                      {canRevoke && (
                        <ActionForm action={revokeAccessToken}>
                          <input type="hidden" name="accessTokenId" value={d.accessTokenId} />
                          <Button type="submit" variant="secondary" size="sm">
                            Revoke
                          </Button>
                        </ActionForm>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Submissions</CardTitle>
        </CardHeader>
        <CardContent>
          {subs.length === 0 ? (
            <p className="text-sm text-zinc-500">No submissions yet.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 text-sm">
              {subs.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2">
                  <Link
                    href={`/dashboard/requests/${id}/submissions/${s.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {s.purgedAt ? "Purged submission" : (s.responderEmail ?? "Submission")}
                    <span className="ml-2 text-zinc-400">
                      {s.submittedAt?.toLocaleString("en-AU") ?? "in progress"}
                    </span>
                  </Link>
                  <Badge variant={statusBadgeVariant(s.status)}>
                    {s.status.replace("_", " ")}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
