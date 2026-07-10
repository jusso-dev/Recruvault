import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { requestTemplates } from "@/db/schema";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { createRequest, deleteTemplate } from "@/actions/requests";
import {
  DEFAULT_REQUEST_FIELD_KEYS,
  FIELD_LIBRARY,
  ROLE_REQUEST_FIELD_KEYS,
  type RequestTemplateDefinition,
} from "@/lib/fields";
import { can } from "@/lib/rbac";
import { ActionForm } from "@/components/action-form";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Textarea,
} from "@/components/ui";

export default async function NewRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const ctx = await requireDashboardUser("requests:create");
  const canManageTemplates = can(ctx.role, "templates:manage");

  const templates = await db
    .select({
      id: requestTemplates.id,
      name: requestTemplates.name,
      definition: requestTemplates.definition,
    })
    .from(requestTemplates)
    .where(eq(requestTemplates.orgId, ctx.orgId))
    .orderBy(desc(requestTemplates.createdAt));

  const sp = await searchParams;
  const selected = templates.find((t) => t.id === sp.template);
  const def = selected?.definition as RequestTemplateDefinition | undefined;
  const selectedKeys = new Set(def?.libraryKeys ?? []);
  const roleFields = ROLE_REQUEST_FIELD_KEYS.map((key) =>
    FIELD_LIBRARY.find((field) => field.key === key),
  ).filter((field): field is NonNullable<typeof field> => Boolean(field));
  const defaultChecked = (key: string) =>
    def ? selectedKeys.has(key) : DEFAULT_REQUEST_FIELD_KEYS.includes(key);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="text-sm font-medium text-accent">Add to hiring pipeline</p>
        <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">
          New role
        </h1>
        <p className="mt-2 text-sm text-stone-500">
          Define the role, application requirements, and secure candidate intake.
        </p>
      </div>

      {templates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Start from a template</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className={`flex items-center gap-1 rounded-full border px-1 ${
                    t.id === selected?.id ? "border-stone-800 bg-stone-50" : "border-stone-200"
                  }`}
                >
                  <Link
                    href={`/dashboard/requests/new?template=${t.id}`}
                    className="px-2 py-1 text-sm hover:underline"
                  >
                    {t.name}
                  </Link>
                  {canManageTemplates && (
                    <ActionForm action={deleteTemplate} className="flex">
                      <input type="hidden" name="templateId" value={t.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete template ${t.name}`}
                        className="h-6 w-6 p-0 text-stone-400"
                      >
                        ×
                      </Button>
                    </ActionForm>
                  )}
                </div>
              ))}
            </div>
            {selected ? (
              <p className="text-xs text-stone-500">
                Pre-filled from <span className="font-medium">{selected.name}</span>. Adjust
                anything before creating.{" "}
                <Link href="/dashboard/requests/new" className="underline">
                  Start blank
                </Link>
              </p>
            ) : (
              <p className="text-xs text-stone-500">
                Pick a template to pre-fill the form below.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <ActionForm
        action={createRequest}
        redirectTo="/dashboard/requests/:id"
        className="space-y-6"
      >
        <Card>
          <CardHeader>
            <CardTitle>Role</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                name="title"
                required
                placeholder="Senior Systems Engineer, NV1"
                defaultValue={def?.title ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="description">Description (shown to the candidate)</Label>
              <Textarea id="description" name="description" defaultValue={def?.description ?? ""} />
            </div>
            <div>
              <Label htmlFor="skills">Skills and keywords</Label>
              <Input
                id="skills"
                name="skills"
                placeholder="Azure, incident response, Microsoft Sentinel"
                defaultValue={def?.skills?.join(", ") ?? ""}
              />
              <p className="mt-1 text-xs leading-5 text-stone-500">
                Comma-separated role metadata used for search and opt-in job-match alerts. This is
                not information requested from the candidate.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="location">Location</Label>
                <Input
                  id="location"
                  name="location"
                  placeholder="Canberra, ACT"
                  defaultValue={def?.location ?? ""}
                />
              </div>
              <div>
                <Label htmlFor="employmentType">Employment type</Label>
                <Select
                  id="employmentType"
                  name="employmentType"
                  defaultValue={def?.employmentType ?? ""}
                >
                  <option value="">Not specified</option>
                  <option value="permanent">Permanent</option>
                  <option value="contract">Contract</option>
                  <option value="fixed_term">Fixed term</option>
                  <option value="casual">Casual</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="workArrangement">Work arrangement</Label>
                <Select
                  id="workArrangement"
                  name="workArrangement"
                  defaultValue={def?.workArrangement ?? ""}
                >
                  <option value="">Not specified</option>
                  <option value="on_site">On-site</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="remote">Remote</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="salaryPeriod">Salary or rate period</Label>
                <Select
                  id="salaryPeriod"
                  name="salaryPeriod"
                  defaultValue={def?.salaryPeriod ?? "annual"}
                >
                  <option value="annual">Annual salary</option>
                  <option value="daily">Daily rate</option>
                  <option value="hourly">Hourly rate</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="salaryMin">Minimum salary or rate</Label>
                <Input
                  id="salaryMin"
                  name="salaryMin"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="120000"
                  defaultValue={def?.salaryMin ?? ""}
                />
              </div>
              <div>
                <Label htmlFor="salaryMax">Maximum salary or rate</Label>
                <Input
                  id="salaryMax"
                  name="salaryMax"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="150000"
                  defaultValue={def?.salaryMax ?? ""}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="jd">Job description (PDF or Word, stored encrypted)</Label>
              <Input
                id="jd"
                name="jd"
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              />
              {def && (
                <p className="mt-1 text-xs text-stone-500">
                  Templates don&apos;t carry the JD file. Attach one if needed.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="jdViewMode">JD access</Label>
              <Select id="jdViewMode" name="jdViewMode" defaultValue={def?.jdViewMode ?? "view_only"}>
                <option value="view_only">View in browser only (watermarked)</option>
                <option value="allow_download">Allow download</option>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Application requirements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-stone-700">
                Candidate requirements
              </legend>
              <p className="mb-3 text-xs text-stone-500">
                Choose only what is needed for this role.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {roleFields.map((field) => (
                  <label
                    key={field.key}
                    className="flex items-start gap-3 rounded-md border border-stone-200 bg-stone-50/60 p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      name="fields"
                      value={field.key}
                      className="mt-0.5"
                      defaultChecked={defaultChecked(field.key)}
                    />
                    <span>
                      <span className="font-medium text-stone-800">{field.label}</span>
                      {field.helpText && (
                        <span className="mt-0.5 block text-xs leading-5 text-stone-500">
                          {field.helpText}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Delivery, consent, and expiry</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="consentPurpose">Purpose statement (shown before any data is collected)</Label>
              <Textarea
                id="consentPurpose"
                name="consentPurpose"
                placeholder="We are collecting this information to confirm your eligibility for a security-cleared role with our client."
              />
            </div>
            <div>
              <Label htmlFor="expiresAt">Link expiry</Label>
              <Input id="expiresAt" name="expiresAt" type="date" />
              <p className="mt-1 text-xs text-stone-500">
                Leave blank for the 14-day default. The link stops working after this.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="listed" />
              List this role (discoverable to seekers you engage with, never a public board)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="saveAsTemplate" />
              Save as a template for reuse
            </label>
          </CardContent>
        </Card>

        <Button type="submit" size="lg">
          Create role
        </Button>
      </ActionForm>
    </div>
  );
}
