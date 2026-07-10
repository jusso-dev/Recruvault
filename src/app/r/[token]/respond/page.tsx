import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accessTokens,
  documents,
  organisations,
  requestFields,
  requests,
  walletItems,
} from "@/db/schema";
import { sha256, decryptField } from "@/lib/crypto";
import { readLinkSession } from "@/lib/link-session";
import { getSession, requireCandidate } from "@/lib/guards";
import { loadOptions } from "@/lib/reference";
import { fieldDefinition } from "@/lib/fields";
import { submitResponse, loadDraftValues } from "@/actions/link";
import { ActionForm } from "@/components/action-form";
import { SaveDraftButton } from "@/components/save-draft-button";
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
  Textarea,
} from "@/components/ui";

/**
 * The response flow, mobile-first: consent and purpose, optional NDA gate,
 * watermarked JD view, requested fields with wallet pre-fill, controlled
 * uploads, review and submit.
 */
export default async function RespondPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const sessionTokenId = await readLinkSession();
  const [at] = await db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, sha256(token)));

  if (!at || !sessionTokenId || sessionTokenId !== at.id || !at.verifiedAt) {
    redirect(`/r/${token}`);
  }
  if (at.consumedAt || at.revokedAt || at.expiresAt < new Date()) redirect(`/r/${token}`);

  const [request] = await db.select().from(requests).where(eq(requests.id, at.requestId));
  const [org] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, request.orgId));

  const fields = await db
    .select()
    .from(requestFields)
    .where(eq(requestFields.requestId, request.id))
    .orderBy(requestFields.sortOrder);

  // Options for controlled-value fields (AGSVA levels etc.).
  const optionsByField = new Map<string, { code: string; label: string }[]>();
  for (const f of fields) {
    if (f.type !== "single_select" && f.type !== "multi_select") continue;
    if (f.options && f.options.length > 0) {
      optionsByField.set(
        f.id,
        f.options.map((o) => ({ code: o, label: o })),
      );
      continue;
    }
    const category = fieldDefinition(f.key)?.referenceCategory;
    if (category) optionsByField.set(f.id, await loadOptions(request.orgId, category));
  }

  // Wallet pre-fill for signed-in job seekers: decrypt matching credentials.
  const prefill = new Map<string, { value: string; walletItemId: string }>();
  const session = await getSession();
  const isCandidate =
    !!session && (session.user as { accountType?: string }).accountType !== "org";
  if (isCandidate) {
    const ctx = await requireCandidate();
    const items = await db
      .select()
      .from(walletItems)
      .where(eq(walletItems.candidateAccountId, ctx.candidateAccountId));
    for (const f of fields) {
      const walletType = fieldDefinition(f.key)?.walletType;
      if (!walletType) continue;
      const item = items.find((i) => i.type === walletType);
      if (!item) continue;
      try {
        prefill.set(f.id, {
          value: await decryptField(item.valueEncrypted, item.dekId),
          walletItemId: item.id,
        });
      } catch {
        // Shredded or unavailable key: skip pre-fill for this item.
      }
    }
  }

  // A previously saved draft (structured answers) for this link, if any.
  const draft = await loadDraftValues(at.id);
  const hasDraft = Object.keys(draft).length > 0;

  const jd = request.jdDocumentId
    ? (await db.select().from(documents).where(eq(documents.id, request.jdDocumentId)))[0]
    : null;

  const watermark = `${at.recipientEmail} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4 py-8">
      <div>
        <p className="text-sm text-stone-500">{org.name} requests via Recruvault</p>
        <h1 className="text-2xl font-bold">{request.title}</h1>
        {request.description && (
          <p className="mt-2 text-sm text-stone-600">{request.description}</p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Who is asking, and why</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-stone-700">
          <p>
            <strong>{org.name}</strong> is requesting the information below for this
            role.
          </p>
          {request.consentPurpose && <p>{request.consentPurpose}</p>}
          <p className="text-xs text-stone-500">
            Collection notice ({request.consentNoticeVersion}): your data is encrypted,
            visible only to authorised staff at {org.name}, never sent by email, and
            automatically deleted {org.retentionDays} days after submission. Every
            access is logged. You can request deletion at any time.
          </p>
        </CardContent>
      </Card>

      {jd && jd.scanStatus === "clean" && (
        <Card>
          <CardHeader>
            <CardTitle>Job description</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative overflow-hidden rounded-lg border border-stone-200">
              <object
                data={`/api/documents/${jd.id}/view`}
                type="application/pdf"
                className="h-[480px] w-full"
                aria-label="Job description PDF"
              >
                <p className="p-4 text-sm">
                  <a
                    className="underline"
                    href={`/api/documents/${jd.id}/view`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the job description
                  </a>
                </p>
              </object>
              {/* Dynamic watermark: responder identity + timestamp, deterrence for screenshots. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 flex flex-wrap content-around items-center justify-around opacity-20"
              >
                {Array.from({ length: 6 }).map((_, i) => (
                  <span key={i} className="rotate-[-20deg] text-xs font-semibold text-stone-700">
                    {watermark}
                  </span>
                ))}
              </div>
            </div>
            {request.jdViewMode === "allow_download" ? (
              <a
                href={`/api/documents/${jd.id}/view?download=1`}
                className="mt-2 inline-block text-sm underline"
              >
                Download PDF
              </a>
            ) : (
              <p className="mt-2 text-xs text-stone-500">
                View-only: the recruiter has disabled downloading for this document.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <ActionForm
        action={submitResponse}
        redirectTo={`/r/${token}/done`}
        className="space-y-6"
      >
        <Card>
          <CardHeader>
            <CardTitle>Requested information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {hasDraft && (
              <p className="rounded-lg border border-accent-tint-border bg-accent-tint p-3 text-sm text-accent">
                We restored your saved draft. Review your answers, re-attach any files,
                then submit.
              </p>
            )}
            {isCandidate && prefill.size > 0 && (
              <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                {prefill.size} field{prefill.size === 1 ? "" : "s"} pre-filled from your
                wallet. Review each value before you submit; sharing is recorded in your
                consent ledger.
              </p>
            )}
            {fields.map((f) => {
              const pre = prefill.get(f.id);
              const name = `field_${f.id}`;
              // A saved draft answer wins over wallet pre-fill (it's the
              // responder's own edit); files are never carried in a draft.
              const initial = draft[f.id] ?? pre?.value;
              return (
                <div key={f.id}>
                  <Label htmlFor={name}>
                    {f.label}
                    {f.required && <span className="text-red-600"> *</span>}
                    {f.sensitive && (
                      <Badge variant="amber" className="ml-2">
                        encrypted
                      </Badge>
                    )}
                  </Label>
                  {f.helpText && (
                    <p className="mb-1 text-xs text-stone-500">{f.helpText}</p>
                  )}
                  {f.type === "single_select" ? (
                    <Select id={name} name={name} defaultValue={initial ?? ""} required={f.required}>
                      <option value="">Select…</option>
                      {(optionsByField.get(f.id) ?? []).map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : f.type === "long_text" ? (
                    <Textarea id={name} name={name} defaultValue={initial} required={f.required} />
                  ) : f.type === "boolean" || f.type === "consent" ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" id={name} name={name} value="yes" />
                      Yes
                    </label>
                  ) : f.type === "file_upload" ? (
                    <Input
                      id={name}
                      name={name}
                      type="file"
                      accept={
                        ["resume", "cover_letter"].includes(f.key)
                          ? ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                          : "application/pdf,image/*"
                      }
                      required={f.required}
                    />
                  ) : (
                    <Input
                      id={name}
                      name={name}
                      type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                      defaultValue={initial}
                      required={f.required}
                    />
                  )}
                  {pre && <input type="hidden" name="walletItemsUsed" value={pre.walletItemId} />}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="consent" required className="mt-0.5" />
              <span>
                I consent to {org.name} collecting this information for the stated
                purpose. I understand it is encrypted, access is audited, and it will
                be deleted automatically after {org.retentionDays} days.
              </span>
            </label>
            {request.ndaDocumentId && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="nda" required className="mt-0.5" />
                <span>I accept the non-disclosure agreement.</span>
              </label>
            )}
            <Button type="submit" size="lg" className="w-full">
              Submit securely
            </Button>
            <SaveDraftButton />
            <p className="text-center text-xs text-stone-500">
              Nothing is sent by email. Your submission goes straight into {org.name}
              &apos;s encrypted vault.
            </p>
          </CardContent>
        </Card>
      </ActionForm>
    </main>
  );
}
