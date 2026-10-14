import "server-only";
import { createHash } from "crypto";
import { and, eq, inArray, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import { dataKeys, documentMigrations, documents, walletDocuments } from "@/db/schema";
import { createDataKey, shredDataKey } from "@/lib/crypto";
import { wrapLegacyDek } from "@/lib/crypto-legacy";
import { enqueueDeletion } from "@/lib/deletion-queue";
import { DOCUMENT_ENVELOPE_VERSION, envelopeAad, putProtectedObject } from "@/lib/document-protect";
import { getLogger } from "@/lib/logger";
import { getObjectBytes, opaqueStorageKey } from "@/lib/storage";
import { activeVault, documentCiphertext } from "@/lib/vault-store";
import { decryptDocumentBytes } from "@/lib/vault-crypto";

/**
 * Legacy plaintext objects -> document envelopes.
 *
 * Each document is sealed to its owner's vault public key, so no customer key
 * has to be unlocked. Per document:
 *
 * 1. Claim a lease on its document_migrations row. An expired earlier attempt
 *    is discarded first (key shredded, object queued for deletion).
 * 2. Read the original and check it against the stored checksum and size.
 * 3. Write ciphertext under a new opaque key, read it back, decrypt, and
 *    compare checksum and size.
 * 4. In one transaction: switch the row to the new object, mark the migration
 *    done, and queue the original for durable deletion.
 *
 * The original stays referenced and readable until step 4 commits, so a crash
 * or failure at any point never loses the only usable copy.
 */

const log = getLogger("document-migration");
const MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const RENDER_DELEGATED_KINDS = new Set(["jd", "nda"]);
// Pending and scanning files are left to the scanner, which reads plaintext.
const MIGRATABLE_SCAN = ["clean", "infected", "error"] as const;

type Table = "documents" | "wallet_documents";

type LegacyRow = {
  table: Table;
  id: string;
  ownerType: "organisation" | "candidate";
  ownerId: string;
  kind: string;
  storageKey: string;
  checksum: string | null;
  sizeBytes: number | null;
};

export type ObjectStore = {
  get: (storageKey: string) => Promise<Buffer>;
  put: (storageKey: string, bytes: Buffer) => Promise<void>;
};

const defaultStore: ObjectStore = { get: getObjectBytes, put: putProtectedObject };

export type MigrationReport = {
  legacyBefore: number;
  migrated: number;
  awaitingEnrollment: number;
  busy: number;
  failed: number;
  remaining: number;
};

function notFailed(table: Table, id: typeof documents.id | typeof walletDocuments.id) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(documentMigrations)
      .where(
        and(
          eq(documentMigrations.tableName, table),
          eq(documentMigrations.documentId, id),
          eq(documentMigrations.state, "failed"),
        ),
      ),
  );
}

const legacyDocument = and(
  eq(documents.envelopeVersion, 0),
  isNull(documents.dekId),
  isNotNull(documents.orgId),
  inArray(documents.scanStatus, [...MIGRATABLE_SCAN]),
);
const legacyWalletDocument = and(
  eq(walletDocuments.envelopeVersion, 0),
  isNull(walletDocuments.dekId),
  inArray(walletDocuments.scanStatus, [...MIGRATABLE_SCAN]),
);

/** Legacy plaintext rows still to migrate (failed ones excluded; see the report). */
export async function countLegacyDocuments(): Promise<{ documents: number; walletDocuments: number }> {
  const [org] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(legacyDocument, notFailed("documents", documents.id)));
  const [wallet] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(walletDocuments)
    .where(and(legacyWalletDocument, notFailed("wallet_documents", walletDocuments.id)));
  return { documents: org?.n ?? 0, walletDocuments: wallet?.n ?? 0 };
}

async function legacyRows(limit: number): Promise<LegacyRow[]> {
  const org = await db
    .select()
    .from(documents)
    .where(and(legacyDocument, notFailed("documents", documents.id)))
    .orderBy(documents.createdAt)
    .limit(limit);
  const wallet = await db
    .select()
    .from(walletDocuments)
    .where(and(legacyWalletDocument, notFailed("wallet_documents", walletDocuments.id)))
    .orderBy(walletDocuments.createdAt)
    .limit(Math.max(0, limit - org.length));
  return [
    ...org.map((d) => ({
      table: "documents" as const,
      id: d.id,
      ownerType: "organisation" as const,
      ownerId: d.orgId!,
      kind: d.kind,
      storageKey: d.storageKey,
      checksum: d.checksum,
      sizeBytes: d.sizeBytes,
    })),
    ...wallet.map((d) => ({
      table: "wallet_documents" as const,
      id: d.id,
      ownerType: "candidate" as const,
      ownerId: d.candidateAccountId,
      kind: d.kind,
      storageKey: d.storageKey,
      checksum: d.checksum,
      sizeBytes: null,
    })),
  ];
}

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Take the per-document lease. Returns the migration row id, or null when another worker holds it. */
async function claim(row: LegacyRow, leaseMs: number): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx
      .insert(documentMigrations)
      .values({
        tableName: row.table,
        documentId: row.id,
        oldStorageKey: row.storageKey,
        newStorageKey: "",
        state: "uploading",
        attempts: 0,
        updatedAt: new Date(0),
      })
      .onConflictDoNothing({ target: [documentMigrations.tableName, documentMigrations.documentId] });
    const [m] = await tx
      .select()
      .from(documentMigrations)
      .where(and(eq(documentMigrations.tableName, row.table), eq(documentMigrations.documentId, row.id)))
      .for("update");
    if (!m || m.state !== "uploading") return null;
    if (m.updatedAt.getTime() > Date.now() - leaseMs) return null;
    // Discard the earlier attempt that stopped before switching.
    if (m.dekId) await shredDataKey(m.dekId, tx);
    if (m.newStorageKey) await enqueueDeletion(tx, m.newStorageKey, row.ownerId);
    await tx
      .update(documentMigrations)
      .set({
        oldStorageKey: row.storageKey,
        newStorageKey: "",
        dekId: null,
        attempts: m.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(documentMigrations.id, m.id));
    return m.id;
  });
}

async function migrateOne(
  row: LegacyRow,
  vault: { publicKey: string; version: number },
  store: ObjectStore,
  migrationId: string,
) {
  const original = await store.get(row.storageKey);
  const checksum = digest(original);
  if (row.checksum && row.checksum !== checksum) throw new Error("Original checksum does not match.");
  if (row.sizeBytes !== null && row.sizeBytes !== original.length) {
    throw new Error("Original size does not match.");
  }

  const { dekId, dek } = await createDataKey(db, {
    mode: "sealed",
    recipientPublicKey: vault.publicKey,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    purpose: row.kind,
    keyVersion: vault.version,
  });
  if (row.table === "documents" && RENDER_DELEGATED_KINDS.has(row.kind)) {
    await db.update(dataKeys).set({ renderWrapped: wrapLegacyDek(dek) }).where(eq(dataKeys.id, dekId));
  }
  const newStorageKey = opaqueStorageKey(row.table === "documents" ? "org" : "wallet", row.ownerId);
  await db
    .update(documentMigrations)
    .set({ dekId, newStorageKey })
    .where(eq(documentMigrations.id, migrationId));

  const aad = envelopeAad(row.ownerType, row.ownerId, row.id, row.kind, DOCUMENT_ENVELOPE_VERSION);
  await store.put(newStorageKey, documentCiphertext(dek, original, aad));
  const roundTrip = decryptDocumentBytes(dek, await store.get(newStorageKey), aad);
  if (roundTrip.length !== original.length || digest(roundTrip) !== checksum) {
    throw new Error("Encrypted copy failed verification.");
  }

  await db.transaction(async (tx) => {
    const owned = await tx
      .update(documentMigrations)
      .set({ state: "done", lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(documentMigrations.id, migrationId),
          eq(documentMigrations.state, "uploading"),
          eq(documentMigrations.dekId, dekId),
        ),
      )
      .returning({ id: documentMigrations.id });
    if (owned.length === 0) throw new Error("Migration lease was lost.");
    const switched =
      row.table === "documents"
        ? await tx
            .update(documents)
            .set({
              storageKey: newStorageKey,
              dekId,
              envelopeVersion: DOCUMENT_ENVELOPE_VERSION,
              originalContentType: sql`coalesce(${documents.originalContentType}, ${documents.contentType})`,
              contentType: "application/octet-stream",
              checksum,
              sizeBytes: original.length,
            })
            .where(
              and(
                eq(documents.id, row.id),
                eq(documents.storageKey, row.storageKey),
                eq(documents.envelopeVersion, 0),
              ),
            )
            .returning({ id: documents.id })
        : await tx
            .update(walletDocuments)
            .set({
              storageKey: newStorageKey,
              dekId,
              envelopeVersion: DOCUMENT_ENVELOPE_VERSION,
              originalContentType: sql`coalesce(${walletDocuments.originalContentType}, ${walletDocuments.contentType})`,
              contentType: "application/octet-stream",
              checksum,
            })
            .where(
              and(
                eq(walletDocuments.id, row.id),
                eq(walletDocuments.storageKey, row.storageKey),
                eq(walletDocuments.envelopeVersion, 0),
              ),
            )
            .returning({ id: walletDocuments.id });
    if (switched.length === 0) throw new Error("Document changed during migration.");
    await enqueueDeletion(tx, row.storageKey, row.ownerId);
  });
}

async function recordFailure(migrationId: string, row: LegacyRow, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message.slice(0, 200) : "migration failed";
  return db.transaction(async (tx) => {
    const [m] = await tx
      .select()
      .from(documentMigrations)
      .where(eq(documentMigrations.id, migrationId))
      .for("update");
    if (!m || m.state !== "uploading") return false;
    const exhausted = m.attempts >= MAX_ATTEMPTS;
    if (exhausted) {
      // Give up on this document. The original stays in place and readable.
      if (m.dekId) await shredDataKey(m.dekId, tx);
      if (m.newStorageKey) await enqueueDeletion(tx, m.newStorageKey, row.ownerId);
    }
    await tx
      .update(documentMigrations)
      .set({
        state: exhausted ? "failed" : "uploading",
        lastError: message,
        ...(exhausted ? { dekId: null, newStorageKey: "" } : {}),
      })
      .where(eq(documentMigrations.id, m.id));
    return exhausted;
  });
}

/**
 * Migrate one batch of legacy plaintext documents. Safe to run concurrently
 * and to rerun after a crash. Returns counts only.
 */
export async function migrateLegacyDocuments(
  opts: { batchSize?: number; store?: Partial<ObjectStore>; leaseMs?: number } = {},
): Promise<MigrationReport> {
  const store = { ...defaultStore, ...opts.store };
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const before = await countLegacyDocuments();
  const report: MigrationReport = {
    legacyBefore: before.documents + before.walletDocuments,
    migrated: 0,
    awaitingEnrollment: 0,
    busy: 0,
    failed: 0,
    remaining: 0,
  };

  for (const row of await legacyRows(opts.batchSize ?? 25)) {
    const vault = await activeVault(row.ownerType, row.ownerId);
    if (!vault?.privateKeyWrapped) {
      report.awaitingEnrollment += 1;
      continue;
    }
    const migrationId = await claim(row, leaseMs);
    if (!migrationId) {
      report.busy += 1;
      continue;
    }
    try {
      await migrateOne(row, vault, store, migrationId);
      report.migrated += 1;
    } catch (error) {
      if (await recordFailure(migrationId, row, error)) report.failed += 1;
      log.warn({ table: row.table, documentId: row.id }, "document migration attempt failed");
    }
  }

  const after = await countLegacyDocuments();
  report.remaining = after.documents + after.walletDocuments;
  log.info(report, report.remaining === 0 ? "legacy document migration complete" : "legacy document migration batch");
  return report;
}

/** Totals across all runs, for the completion report. Counts only. */
export async function documentMigrationTotals(): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: documentMigrations.state, n: sql<number>`count(*)::int` })
    .from(documentMigrations)
    .groupBy(documentMigrations.state);
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

/** Expired leases older than this are stuck migrations for the reconciler report. */
export async function stuckMigrationCount(olderThanMs = DEFAULT_LEASE_MS * 6): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documentMigrations)
    .where(
      and(
        eq(documentMigrations.state, "uploading"),
        lt(documentMigrations.updatedAt, new Date(Date.now() - olderThanMs)),
      ),
    );
  return row?.n ?? 0;
}
