import { desc, eq } from "drizzle-orm";
import { FileText, Upload } from "lucide-react";
import { deleteWalletDocument, uploadWalletDocument } from "@/actions/wallet";
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
import { db } from "@/db";
import { walletDocuments } from "@/db/schema";
import { WALLET_DOCUMENT_TYPES } from "@/lib/fields";
import { requireCandidate } from "@/lib/guards";

type WalletDocument = typeof walletDocuments.$inferSelect;

function documentLabel(kind: string) {
  return (
    WALLET_DOCUMENT_TYPES.find((type) => type.type === kind)?.label ??
    kind.replaceAll("_", " ")
  );
}

function DocumentList({
  title,
  items,
  empty,
}: {
  title: string;
  items: WalletDocument[];
  empty: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <Badge>{items.length}</Badge>
        </div>
      </CardHeader>
      {items.length === 0 ? (
        <CardContent className="py-8 text-sm text-stone-500">{empty}</CardContent>
      ) : (
        <ul className="divide-y divide-stone-100">
          {items.map((document) => (
            <li
              key={document.id}
              className="flex flex-col justify-between gap-3 px-5 py-4 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-500">
                  <FileText className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-stone-800">
                    {documentLabel(document.kind)}
                  </p>
                  <p className="tnum mt-0.5 truncate text-xs text-stone-500">
                    {document.fileName} · uploaded {document.createdAt.toLocaleDateString("en-AU")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={statusBadgeVariant(document.scanStatus)}>
                  {document.scanStatus}
                </Badge>
                {document.scanStatus === "clean" && (
                  <ButtonLink
                    href={`/api/wallet/documents/${document.id}/view`}
                    target="_blank"
                    rel="noreferrer"
                    variant="secondary"
                    size="sm"
                  >
                    View
                  </ButtonLink>
                )}
                <ActionForm action={deleteWalletDocument} successMessage="Document deleted.">
                  <input type="hidden" name="id" value={document.id} />
                  <Button type="submit" variant="ghost" size="sm">Delete</Button>
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default async function CareerDocumentsPage() {
  const ctx = await requireCandidate();
  const documents = await db
    .select()
    .from(walletDocuments)
    .where(eq(walletDocuments.candidateAccountId, ctx.candidateAccountId))
    .orderBy(desc(walletDocuments.createdAt));

  const careerDocuments = documents.filter((document) =>
    WALLET_DOCUMENT_TYPES.some((type) => type.type === document.kind),
  );
  return (
    <div className="max-w-5xl space-y-8">
      <header>
        <p className="text-sm font-medium text-accent">Reusable for every application</p>
        <h1 className="mt-1 text-[1.9rem] font-semibold tracking-[-0.035em] text-stone-950">
          Career documents
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-500">
          Keep your current resume and tailored cover letters or suitability statements.
          Choose what to share for each application. We do not collect identity or police-check documents.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Upload a document</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={uploadWalletDocument}
            successMessage="Uploaded. It will be available after security scanning."
            resetOnSuccess
            className="grid items-end gap-3 sm:grid-cols-[200px_minmax(0,1fr)_auto]"
          >
            <div>
              <Label htmlFor="kind">Document type</Label>
              <Select id="kind" name="kind">
                <optgroup label="Career documents">
                  {WALLET_DOCUMENT_TYPES.filter((type) => type.group === "career").map((type) => (
                    <option key={type.type} value={type.type}>{type.label}</option>
                  ))}
                </optgroup>
              </Select>
            </div>
            <div>
              <Label htmlFor="file">PDF, Word, or image, up to 15 MB</Label>
              <Input
                id="file"
                name="file"
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
                required
              />
            </div>
            <Button type="submit">
              <Upload className="h-4 w-4" aria-hidden />
              Upload
            </Button>
          </ActionForm>
        </CardContent>
      </Card>

      <DocumentList
        title="Resumes and cover letters"
        items={careerDocuments}
        empty="No career documents yet. Add your current resume to make future applications faster."
      />
    </div>
  );
}
