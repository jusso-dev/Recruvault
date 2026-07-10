import Link from "next/link";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { requestTemplates } from "@/db/schema";
import { requireOrgUser } from "@/lib/guards";
import { createRequest, deleteTemplate } from "@/actions/requests";
import { FIELD_LIBRARY, type RequestTemplateDefinition } from "@/lib/fields";
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
  const ctx = await requireOrgUser("requests:create");
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
  const customFieldsDefault = (def?.customLabels ?? []).join("\n");

  const clearanceFields = FIELD_LIBRARY.filter((f) => f.key.startsWith("clearance") || f.key === "sponsoring_agency");
  const identityFields = FIELD_LIBRARY.filter((f) => !clearanceFields.includes(f));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">New secure request</h1>

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
                placeholder="Senior Systems Engineer — NV1"
                defaultValue={def?.title ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="description">Description (shown to the candidate)</Label>
              <Textarea id="description" name="description" defaultValue={def?.description ?? ""} />
            </div>
            <div>
              <Label htmlFor="jd">Job description (PDF, stored encrypted)</Label>
              <Input id="jd" name="jd" type="file" accept="application/pdf" />
              {def && (
                <p className="mt-1 text-xs text-stone-500">
                  Templates don&apos;t carry the JD file — attach one if needed.
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
            <CardTitle>Requested information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-stone-700">
                Clearance
              </legend>
              <div className="space-y-2">
                {clearanceFields.map((f) => (
                  <label key={f.key} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="fields"
                      value={f.key}
                      className="mt-0.5"
                      defaultChecked={selectedKeys.has(f.key)}
                    />
                    <span>
                      {f.label}
                      {f.helpText && (
                        <span className="block text-xs text-stone-500">{f.helpText}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-stone-700">
                Identity and eligibility
              </legend>
              <div className="space-y-2">
                {identityFields.map((f) => (
                  <label key={f.key} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="fields"
                      value={f.key}
                      className="mt-0.5"
                      defaultChecked={selectedKeys.has(f.key)}
                    />
                    <span>
                      {f.label}
                      {f.helpText && (
                        <span className="block text-xs text-stone-500">{f.helpText}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <Label htmlFor="customFields">Custom fields (one label per line, optional)</Label>
              <Textarea
                id="customFields"
                name="customFields"
                placeholder={"Notice period\nPreferred location"}
                defaultValue={customFieldsDefault}
              />
            </div>
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
              List this role (discoverable to seekers you engage with — never a public board)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="saveAsTemplate" />
              Save as a template for reuse
            </label>
          </CardContent>
        </Card>

        <Button type="submit" size="lg">
          Create request
        </Button>
      </ActionForm>
    </div>
  );
}
