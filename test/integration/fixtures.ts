import { randomBytes, randomUUID } from "crypto";
import type { db as Db } from "@/db";
import {
  accessTokens,
  candidateAccounts,
  organisations,
  requestFields,
  requests,
  submissions,
  user,
} from "@/db/schema";

/** Synthetic rows for integration suites. No real names, addresses, or keys. */

type Database = typeof Db;

export async function createUser(db: Database, accountType: "org" | "seeker" = "seeker") {
  const id = randomUUID();
  await db.insert(user).values({
    id,
    name: "Test Person",
    email: `${id}@example.test`,
    emailVerified: true,
    accountType,
  });
  return id;
}

export async function createOrgWithVault(
  db: Database,
  opts: { vault?: boolean; retentionDays?: number; purgeOnClose?: boolean } = {},
) {
  const { insertVaultKey } = await import("@/lib/vault-store");
  const [org] = await db
    .insert(organisations)
    .values({
      name: "Test Org",
      slug: `org-${randomBytes(4).toString("hex")}`,
      retentionDays: opts.retentionDays ?? 90,
      purgeOnClose: opts.purgeOnClose ?? false,
    })
    .returning();
  const crk = randomBytes(32);
  const vault =
    opts.vault === false
      ? null
      : await insertVaultKey(db, { ownerType: "organisation", ownerId: org.id, crk });
  return { orgId: org.id, crk, vault, ownerUserId: await createUser(db, "org") };
}

export async function createCandidateWithVault(db: Database, userId?: string) {
  const { insertVaultKey } = await import("@/lib/vault-store");
  const uid = userId ?? (await createUser(db));
  const [ca] = await db.insert(candidateAccounts).values({ userId: uid }).returning();
  const crk = randomBytes(32);
  const vault = await insertVaultKey(db, { ownerType: "candidate", ownerId: ca.id, crk });
  return { userId: uid, candidateAccountId: ca.id, crk, vault };
}

export async function createRequestWithLink(
  db: Database,
  org: { orgId: string; ownerUserId: string },
  opts: {
    status?: "open" | "closed" | "archived";
    closedAt?: Date | null;
    expiresAt?: Date | null;
    linkExpiresAt?: Date;
    linkRevokedAt?: Date | null;
  } = {},
) {
  const [request] = await db
    .insert(requests)
    .values({
      orgId: org.orgId,
      createdBy: org.ownerUserId,
      title: "Test role",
      status: opts.status ?? "open",
      closedAt: opts.closedAt ?? null,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning();
  const [field] = await db
    .insert(requestFields)
    .values({ requestId: request.id, key: "resume", type: "file_upload", label: "Resume" })
    .returning();
  const [textField] = await db
    .insert(requestFields)
    .values({ requestId: request.id, key: "custom", type: "short_text", label: "Note" })
    .returning();
  const [token] = await db
    .insert(accessTokens)
    .values({
      requestId: request.id,
      tokenHash: randomBytes(32).toString("hex"),
      recipientEmail: "responder@example.test",
      expiresAt: opts.linkExpiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: opts.linkRevokedAt ?? null,
    })
    .returning();
  return { requestId: request.id, fieldId: field.id, textFieldId: textField.id, accessTokenId: token.id };
}

export async function createSubmission(
  db: Database,
  link: { requestId: string; accessTokenId: string },
  opts: { status?: "started" | "received"; submittedAt?: Date | null; candidateAccountId?: string } = {},
) {
  const status = opts.status ?? "received";
  const [sub] = await db
    .insert(submissions)
    .values({
      requestId: link.requestId,
      accessTokenId: link.accessTokenId,
      candidateAccountId: opts.candidateAccountId ?? null,
      responderEmail: "responder@example.test",
      status,
      submittedAt: status === "started" ? null : (opts.submittedAt ?? new Date()),
    })
    .returning();
  return sub.id;
}

/** A small valid-looking PDF carrying a unique marker that must never appear in storage. */
export function samplePdf(marker: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${marker}\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

export function samplePng(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`tEXtComment\0${marker}`, "latin1"),
  ]);
}

export function sampleDocx(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`word/document.xml<w:t>${marker}</w:t>`, "latin1"),
  ]);
}
