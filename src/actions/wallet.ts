"use server";

import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  requests,
  savedRoles,
  walletDocuments,
  walletItems,
  walletShares,
} from "@/db/schema";
import { requireCandidate, requestMeta } from "@/lib/guards";
import { encryptField, shredDataKey } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { inngest } from "@/inngest/client";
import { newStorageKey, putObjectBytes, deleteObject } from "@/lib/storage";
import { sniffContentType } from "@/lib/scan";
import {
  UPLOAD_ALLOWED_TYPES,
  UPLOAD_MAX_BYTES,
  WALLET_ITEM_TYPES,
} from "@/lib/fields";
import { sendErasureConfirmation } from "@/lib/email";
import { eraseCandidate } from "@/lib/retention";
import type { ActionResult } from "./org";

/** Create or update a wallet credential. Values are field-level encrypted. */
export async function upsertWalletItem(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  const type = String(formData.get("type") ?? "");
  const value = String(formData.get("value") ?? "").trim();

  if (!WALLET_ITEM_TYPES.some((t) => t.type === type)) {
    return { ok: false, error: "Unknown credential type." };
  }
  if (!value) return { ok: false, error: "A value is required." };

  const [existing] = await db
    .select()
    .from(walletItems)
    .where(
      and(
        eq(walletItems.candidateAccountId, ctx.candidateAccountId),
        eq(walletItems.type, type),
      ),
    );

  const { valueEncrypted, dekId } = await encryptField(value);

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
  return { ok: true };
}

/** Delete a wallet credential via crypto-shred. */
export async function deleteWalletItem(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
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
  return { ok: true };
}

/** Upload a reusable wallet document (passport, licence, other evidence). */
export async function uploadWalletDocument(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  const kind = String(formData.get("kind") ?? "other");
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a file to upload." };
  }
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, error: "File exceeds 15 MB." };

  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffContentType(bytes);
  if (!sniffed || !UPLOAD_ALLOWED_TYPES.includes(sniffed)) {
    return { ok: false, error: "Only PDF and image files are accepted." };
  }

  const storageKey = newStorageKey("wallet", ctx.candidateAccountId, file.name);
  await putObjectBytes(storageKey, bytes, sniffed);

  const [doc] = await db
    .insert(walletDocuments)
    .values({
      candidateAccountId: ctx.candidateAccountId,
      kind,
      fileName: file.name,
      contentType: sniffed,
      storageKey,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    })
    .returning({ id: walletDocuments.id });

  await inngest.send({
    name: "document/uploaded",
    data: { documentId: doc.id, table: "wallet_documents" },
  });

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
  return { ok: true };
}

export async function deleteWalletDocument(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
  const id = String(formData.get("id") ?? "");

  const [doc] = await db
    .select()
    .from(walletDocuments)
    .where(
      and(
        eq(walletDocuments.id, id),
        eq(walletDocuments.candidateAccountId, ctx.candidateAccountId),
      ),
    );
  if (!doc) return { ok: false, error: "Not found." };

  try {
    await deleteObject(doc.storageKey);
  } catch (err) {
    console.error(`Failed to delete object ${doc.storageKey}:`, err);
  }
  await db.delete(walletDocuments).where(eq(walletDocuments.id, doc.id));

  const meta = await requestMeta();
  await audit({
    actorType: "candidate",
    actorId: ctx.candidateAccountId,
    action: "wallet_document.deleted",
    targetType: "wallet_document",
    targetId: doc.id,
    ...meta,
  });

  revalidatePath("/wallet");
  return { ok: true };
}

/** Revoke future use of a shared credential or document. */
export async function revokeWalletShare(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
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
  return { ok: true };
}

/** Favourite / unfavourite a role the seeker has access to. */
export async function toggleSavedRole(formData: FormData): Promise<ActionResult> {
  const ctx = await requireCandidate();
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
  return { ok: true };
}
