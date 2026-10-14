"use server";

import { createHash, randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  discoveryProfiles,
  requests,
  savedRoles,
  walletDocuments,
  walletItems,
  walletShares,
} from "@/db/schema";
import { requireCandidate, requestMeta, requireUnlockedCandidate, requireEnrolledCandidate } from "@/lib/guards";
import { encryptField, shredDataKey } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { enqueueEvent, publishAfterCommit } from "@/lib/outbox";
import { activeVault } from "@/lib/vault-store";
import { readUnlockedCustomerKey } from "@/lib/vault-session";
import { discardProtectedUploads, protectDocument, putProtectedObject } from "@/lib/document-protect";
import { getLogger } from "@/lib/logger";
import { sniffContentType } from "@/lib/scan";
import {
  UPLOAD_MAX_BYTES,
  WALLET_DOCUMENT_TYPES,
  WALLET_ITEM_TYPES,
  allowedTypesForWalletDocument,
} from "@/lib/fields";
import { sendErasureConfirmation } from "@/lib/email";
import { deleteWalletDocumentRecord, eraseCandidate } from "@/lib/retention";
import type { ActionResult } from "./org";

const log = getLogger("wallet");

/** Create or update a wallet credential. Values are field-level encrypted. */
export async function upsertWalletItem(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  const type = String(formData.get("type") ?? "");
  const value = String(formData.get("value") ?? "").trim();

  if (!WALLET_ITEM_TYPES.some((t) => t.type === type)) {
    return { ok: false, error: "Unknown credential type." };
  }
  if (!value) return { ok: false, error: "A value is required." };
  const crk = await readUnlockedCustomerKey("candidate", ctx.candidateAccountId);
  const vault = await activeVault("candidate", ctx.candidateAccountId);
  if (!crk || !vault) return { ok: false, error: "Unlock your encryption key before saving credentials." };

  const [existing] = await db
    .select()
    .from(walletItems)
    .where(
      and(
        eq(walletItems.candidateAccountId, ctx.candidateAccountId),
        eq(walletItems.type, type),
      ),
    );

  const { valueEncrypted, dekId } = await encryptField(value, {
    mode: "crk",
    crk,
    ownerType: "candidate",
    ownerId: ctx.candidateAccountId,
    purpose: type,
    keyVersion: vault.version,
  });

  if (existing) {
    // Shred the old key so the previous value is unrecoverable.
    await db
      .update(walletItems)
      .set({ valueEncrypted, dekId, updatedAt: new Date() })
      .where(eq(walletItems.id, existing.id));
    await shredDataKey(existing.dekId);
  } else {
    await db.insert(walletItems).values({
      candidateAccountId: ctx.candidateAccountId,
      type,
      valueEncrypted,
      dekId,
    });
  }

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: existing ? "wallet_item.updated" : "wallet_item.created",
    targetType: "wallet_item",
    targetId: existing?.id,
    ...meta,
  });

  revalidatePath("/wallet");
  revalidatePath("/overview");
  return { ok: true };
}

/** Delete a wallet credential via crypto-shred. */
export async function deleteWalletItem(formData: FormData): Promise<ActionResult> {
  const ctx = await requireEnrolledCandidate();
  const id = String(formData.get("id") ?? "");

  const [item] = await db
    .select()
    .from(walletItems)
    .where(
      and(eq(walletItems.id, id), eq(walletItems.candidateAccountId, ctx.candidateAccountId)),
    );
  if (!item) return { ok: false, error: "Not found." };

  await shredDataKey(item.dekId);
  await db.delete(walletItems).where(eq(walletItems.id, item.id));

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "wallet_item.deleted",
    targetType: "wallet_item",
    targetId: item.id,
    ...meta,
  });

  revalidatePath("/wallet");
  revalidatePath("/overview");
  return { ok: true };
}

/** Upload a reusable career document. Identity and background-check documents are not accepted. */
export async function uploadWalletDocument(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  const kind = String(formData.get("kind") ?? "other");
  const file = formData.get("file");

  if (!WALLET_DOCUMENT_TYPES.some((type) => type.type === kind)) {
    return { ok: false, error: "Unknown document type." };
  }

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a file to upload." };
  }
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, error: "File exceeds 15 MB." };

  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffContentType(bytes);
  const crk = await readUnlockedCustomerKey("candidate", ctx.candidateAccountId);
  const vault = await activeVault("candidate", ctx.candidateAccountId);
  if (!crk || !vault) return { ok: false, error: "Unlock your encryption key before uploading." };
  if (!sniffed || !allowedTypesForWalletDocument(kind).includes(sniffed)) {
    return {
      ok: false,
      error: ["resume", "cover_letter", "selection_criteria"].includes(kind)
        ? "Use a PDF or Word document for this career document."
        : "Use a PDF or image for this document type.",
    };
  }

  const prepared = await protectDocument({
    executor: db,
    bytes,
    ownerType: "candidate",
    ownerId: ctx.candidateAccountId,
    purpose: kind,
    keyVersion: vault.version,
    crk,
    scope: "wallet",
  });
  if (!prepared.ok) return prepared;

  let doc: { id: string };
  try {
    await putProtectedObject(prepared.storageKey, prepared.ciphertext);
    [doc] = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(walletDocuments)
        .values({
          id: prepared.documentId,
          candidateAccountId: ctx.candidateAccountId,
          kind,
          fileName: file.name,
          contentType: "application/octet-stream",
          originalContentType: sniffed,
          storageKey: prepared.storageKey,
          checksum: createHash("sha256").update(bytes).digest("hex"),
          dekId: prepared.dekId,
          envelopeVersion: prepared.envelopeVersion,
          scanStatus: "clean",
        })
        .returning({ id: walletDocuments.id });
      await enqueueEvent(
        tx,
        "document/uploaded",
        { documentId: inserted.id, table: "wallet_documents" },
        `document/uploaded:wallet_documents:${inserted.id}`,
        ctx.candidateAccountId,
      );
      return [inserted];
    });
  } catch (err) {
    // The row did not commit: shred the key and queue the object durably.
    await discardProtectedUploads(
      [{ storageKey: prepared.storageKey, dekId: prepared.dekId }],
      ctx.candidateAccountId,
    ).catch((cleanupErr) =>
      log.error({ err: cleanupErr }, "wallet upload compensation failed; reconciler will collect"),
    );
    log.error({ err }, "wallet document upload failed");
    return { ok: false, error: "Could not save the document. Please try again." };
  }
  await publishAfterCommit();

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "wallet_document.uploaded",
    targetType: "wallet_document",
    targetId: doc.id,
    ...meta,
  });

  revalidatePath("/wallet");
  revalidatePath("/documents");
  revalidatePath("/overview");
  return { ok: true };
}

export async function deleteWalletDocument(formData: FormData): Promise<ActionResult> {
  const ctx = await requireEnrolledCandidate();
  const id = String(formData.get("id") ?? "");

  // Crypto-shred, queue durable object deletion, and drop the row together.
  if (!(await deleteWalletDocumentRecord(ctx.candidateAccountId, id))) {
    return { ok: false, error: "Not found." };
  }

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "wallet_document.deleted",
    targetType: "wallet_document",
    targetId: id,
    ...meta,
  });

  revalidatePath("/wallet");
  revalidatePath("/documents");
  revalidatePath("/overview");
  return { ok: true };
}

/** Revoke future use of a shared credential or document. */
export async function revokeWalletShare(formData: FormData): Promise<ActionResult> {
  const ctx = await requireEnrolledCandidate();
  const id = String(formData.get("id") ?? "");

  const [share] = await db
    .select()
    .from(walletShares)
    .where(
      and(
        eq(walletShares.id, id),
        eq(walletShares.candidateAccountId, ctx.candidateAccountId),
      ),
    );
  if (!share) return { ok: false, error: "Not found." };
  if (share.revokedAt) return { ok: true };

  await db
    .update(walletShares)
    .set({ revokedAt: new Date() })
    .where(eq(walletShares.id, share.id));

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "wallet_share.revoked",
    targetType: "wallet_share",
    targetId: share.id,
    ...meta,
  });

  revalidatePath("/wallet");
  revalidatePath("/overview");
  return { ok: true };
}

/** Favourite / unfavourite a role the seeker has access to. */
export async function toggleSavedRole(formData: FormData): Promise<ActionResult> {
  const ctx = await requireUnlockedCandidate();
  const requestId = String(formData.get("requestId") ?? "");

  // Only listed (seeker-discoverable) roles can be favourited; don't let an
  // arbitrary request id confirm existence of an unlisted role.
  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.listed, true)));
  if (!request) return { ok: false, error: "Role not found." };

  const [existing] = await db
    .select()
    .from(savedRoles)
    .where(
      and(
        eq(savedRoles.candidateAccountId, ctx.candidateAccountId),
        eq(savedRoles.requestId, requestId),
      ),
    );

  if (existing) {
    await db.delete(savedRoles).where(eq(savedRoles.id, existing.id));
  } else {
    await db.insert(savedRoles).values({
      candidateAccountId: ctx.candidateAccountId,
      requestId,
    });
  }

  revalidatePath("/roles");
  revalidatePath("/overview");
  return { ok: true };
}

/** Job seeker erasure: wallet, documents, and submissions — crypto-shredded. */
export async function requestErasure(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  if (String(formData.get("confirm") ?? "") !== "DELETE") {
    return { ok: false, error: 'Type "DELETE" to confirm erasure.' };
  }

  await eraseCandidate(ctx.candidateAccountId);
  await sendErasureConfirmation({ to: ctx.userEmail });

  revalidatePath("/wallet");
  revalidatePath("/overview");
  return { ok: true };
}

/**
 * Opt into (or out of) recruiter discovery and edit the plaintext profile that
 * matching reads. Only the facts entered here are ever exposed, and only as an
 * opaque handle. Never touches wallet ciphertext or documents.
 */
export async function upsertDiscoveryProfile(formData: FormData): Promise<ActionResult> {
  const ctx = await requireUnlockedCandidate();

  const discoverable = formData.get("discoverable") === "on";
  const clearanceLevel = String(formData.get("clearanceLevel") ?? "").trim() || null;
  const location = String(formData.get("location") ?? "").trim() || null;
  const skills = String(formData.get("skills") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);

  const [existing] = await db
    .select({ handle: discoveryProfiles.handle })
    .from(discoveryProfiles)
    .where(eq(discoveryProfiles.candidateAccountId, ctx.candidateAccountId));
  const handle = existing?.handle ?? `cand_${randomBytes(5).toString("hex")}`;

  await db
    .insert(discoveryProfiles)
    .values({
      candidateAccountId: ctx.candidateAccountId,
      handle,
      discoverable,
      clearanceLevel,
      // These fields are retained in the schema for compatibility, but are
      // deliberately cleared. Recruvault does not collect this sensitive PII.
      citizenship: null,
      rightToWork: null,
      skills,
      location,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: discoveryProfiles.candidateAccountId,
      set: {
        discoverable,
        clearanceLevel,
        citizenship: null,
        rightToWork: null,
        skills,
        location,
        updatedAt: new Date(),
      },
    });

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: discoverable ? "discovery.enabled" : "discovery.updated",
    targetType: "discovery_profile",
    targetId: ctx.candidateAccountId,
    ...meta,
  });

  revalidatePath("/wallet");
  revalidatePath("/overview");
  return { ok: true };
}
