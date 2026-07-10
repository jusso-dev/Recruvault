import { desc, eq, sql } from "drizzle-orm";
import { BellRing, ShieldCheck } from "lucide-react";
import { updateRecruiterMatchSettings } from "@/actions/job-alerts";
import { ActionForm } from "@/components/action-form";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Select,
} from "@/components/ui";
import { db } from "@/db";
import {
  jobMatchNotifications,
  recruiterMatchSettings,
  requests,
} from "@/db/schema";
import { requireDashboardUser } from "@/lib/dashboard-auth";

export default async function RecruiterJobAlertsPage() {
  const ctx = await requireDashboardUser("requests:create");
  const [settings] = await db
    .select()
    .from(recruiterMatchSettings)
    .where(eq(recruiterMatchSettings.orgId, ctx.orgId));
  const activity = await db
    .select({
      roleId: requests.id,
      title: requests.title,
      notifications: sql<number>`count(${jobMatchNotifications.id})::int`,
      sent: sql<number>`count(${jobMatchNotifications.id}) filter (where ${jobMatchNotifications.status} = 'sent')::int`,
      lastActivityAt: sql<Date>`max(${jobMatchNotifications.updatedAt})`,
    })
    .from(jobMatchNotifications)
    .innerJoin(requests, eq(requests.id, jobMatchNotifications.requestId))
    .where(eq(jobMatchNotifications.orgId, ctx.orgId))
    .groupBy(requests.id)
    .orderBy(desc(sql`max(${jobMatchNotifications.updatedAt})`))
    .limit(8);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <p className="text-sm font-medium text-accent">Opt-in sourcing</p>
        <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">
          Matched role alerts
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500">
          Notify subscribed job seekers when a listed role matches the skills and interests they
          chose. Recruvault does not expose their identity, profile, or documents to your
          organisation through matching.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-accent" aria-hidden />
            Automation settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={updateRecruiterMatchSettings}
            successMessage="Matched role alert settings saved."
            className="space-y-5"
          >
            <label className="flex items-start gap-3 rounded-md border border-stone-200 bg-stone-50/70 p-4">
              <input
                type="checkbox"
                name="enabled"
                className="mt-1"
                defaultChecked={settings?.enabled ?? false}
              />
              <span>
                <span className="block text-sm font-semibold text-stone-900">
                  Send automated matched-role emails
                </span>
                <span className="mt-1 block text-xs leading-5 text-stone-500">
                  Applies only to open, listed roles with skill tags and job seekers who have
                  explicitly enabled alerts.
                </span>
              </span>
            </label>
            <div className="max-w-sm">
              <Label htmlFor="minimumMatchScore">Minimum role-skill match</Label>
              <Select
                id="minimumMatchScore"
                name="minimumMatchScore"
                defaultValue={String(settings?.minimumMatchScore ?? 50)}
              >
                <option value="25">25% — broad discovery</option>
                <option value="50">50% — balanced</option>
                <option value="75">75% — close match</option>
                <option value="100">100% — exact skill coverage</option>
              </Select>
              <p className="mt-1 text-xs leading-5 text-stone-500">
                Location, employment type, work arrangement, and salary preferences must also
                match when the job seeker sets them.
              </p>
            </div>
            <Button type="submit">Save alert settings</Button>
          </ActionForm>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-accent-tint-border bg-accent-tint p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Dual consent boundary</h2>
            <p className="mt-1 text-sm leading-6 text-stone-600">
              Both sides must opt in. Disabling this setting stops new recruiter-triggered alerts;
              job seekers can stop or change their own subscription at any time. Each role and job
              seeker pair is notified at most once, with no more than five matched-role emails sent
              to a job seeker in any 24-hour period.
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Recent match activity</CardTitle>
            <Badge>{activity.reduce((total, row) => total + row.sent, 0)} sent</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-sm leading-6 text-stone-500">
              No matched alerts yet. Add skill tags to a listed role, enable automation, and alerts
              will appear here without revealing job-seeker identities.
            </p>
          ) : (
            <div className="divide-y divide-stone-100">
              {activity.map((row) => (
                <div
                  key={row.roleId}
                  className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-center"
                >
                  <div>
                    <p className="text-sm font-semibold text-stone-900">{row.title}</p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {row.sent} sent · {row.notifications - row.sent} queued, skipped, or failed
                    </p>
                  </div>
                  <span className="tnum text-xs text-stone-400">
                    {row.lastActivityAt?.toLocaleDateString("en-AU")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
