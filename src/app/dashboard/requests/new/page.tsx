import { requireOrgUser } from "@/lib/guards";
import { createRequest } from "@/actions/requests";
import { FIELD_LIBRARY } from "@/lib/fields";
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

export default async function NewRequestPage() {
  await requireOrgUser("requests:create");

  const clearanceFields = FIELD_LIBRARY.filter((f) => f.key.startsWith("clearance") || f.key === "sponsoring_agency");
  const identityFields = FIELD_LIBRARY.filter((f) => !clearanceFields.includes(f));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">New secure request</h1>
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
              <Input id="title" name="title" required placeholder="Senior Systems Engineer — NV1" />
            </div>
            <div>
              <Label htmlFor="description">Description (shown to the candidate)</Label>
              <Textarea id="description" name="description" />
            </div>
            <div>
              <Label htmlFor="jd">Job description (PDF, stored encrypted)</Label>
              <Input id="jd" name="jd" type="file" accept="application/pdf" />
            </div>
            <div>
              <Label htmlFor="jdViewMode">JD access</Label>
              <Select id="jdViewMode" name="jdViewMode" defaultValue="view_only">
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
              <legend className="mb-2 text-sm font-semibold text-zinc-700">
                Clearance
              </legend>
              <div className="space-y-2">
                {clearanceFields.map((f) => (
                  <label key={f.key} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="fields" value={f.key} className="mt-0.5" />
                    <span>
                      {f.label}
                      {f.helpText && (
                        <span className="block text-xs text-zinc-500">{f.helpText}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-zinc-700">
                Identity and eligibility
              </legend>
              <div className="space-y-2">
                {identityFields.map((f) => (
                  <label key={f.key} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="fields" value={f.key} className="mt-0.5" />
                    <span>
                      {f.label}
                      {f.helpText && (
                        <span className="block text-xs text-zinc-500">{f.helpText}</span>
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
              <p className="mt-1 text-xs text-zinc-500">
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
