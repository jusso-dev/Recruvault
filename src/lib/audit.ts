import "server-only";
import { createHash } from "crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditChainCheckpoints, auditEvents } from "@/db/schema";

/**
 * Append-only, hash-chained audit trail.
 *
 * Each event's hash covers the previous event's hash plus the event content,
 * so any tampering breaks the chain and is detectable. Chains are scoped per
 * organisation, with a global chain (orgId null) for candidate-side events.
 *
 * Events reference targets by id, never by value — no PII enters the log.
 * The log is retained on a metadata-only basis after PII is purged, so the
 * record of handling survives the data itself.
 */

export type AuditActorType = "org_user" | "candidate" | "link_responder" | "system";

export interface AuditInput {
  orgId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

interface HashableEvent {
  orgId?: string | null;
  actorType: string;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
}

function eventHash(prevHash: string, seq: number, e: HashableEvent, at: string): string {
  const canonical = JSON.stringify({
    prevHash,
    seq,
    orgId: e.orgId ?? null,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    at,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const GENESIS = "0".repeat(64);

export async function audit(e: AuditInput): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialise appends per chain so seq/prev_hash stay consistent.
    const chainScope = e.orgId ?? "global";
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + chainScope}))`,
    );

    const [last] = await tx
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(e.orgId ? eq(auditEvents.orgId, e.orgId) : isNull(auditEvents.orgId))
      .orderBy(desc(auditEvents.seq))
      .limit(1);

    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const at = new Date().toISOString();

    await tx.insert(auditEvents).values({
      orgId: e.orgId ?? null,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      seq,
      prevHash,
      hash: eventHash(prevHash, seq, e, at),
      hashedAt: at,
    });
  });
}

interface VerifiableRow extends HashableEvent {
  seq: number;
  prevHash: string;
  hash: string;
  hashedAt: string;
}

/**
 * Pure chain verification over an ordered slice of rows. Checks both linkage
 * (each row chains to the previous hash) and content integrity (the stored
 * hash recomputes from the stored columns). DB-free, so unit-testable.
 */
export function verifyChainRows(
  rows: VerifiableRow[],
  startPrevHash: string = GENESIS,
): { ok: boolean; brokenAtSeq?: number; lastSeq?: number; lastHash?: string } {
  let prev = startPrevHash;
  let lastSeq: number | undefined;
  let lastHash: string | undefined;
  for (const row of rows) {
    if (row.prevHash !== prev) return { ok: false, brokenAtSeq: row.seq };
    const recomputed = eventHash(row.prevHash, row.seq, row, row.hashedAt);
    if (recomputed !== row.hash) return { ok: false, brokenAtSeq: row.seq };
    prev = row.hash;
    lastSeq = row.seq;
    lastHash = row.hash;
  }
  return { ok: true, lastSeq, lastHash };
}

/** Verify the full integrity of an organisation's audit chain. */
export async function verifyChain(orgId: string | null): Promise<{
  ok: boolean;
  brokenAtSeq?: number;
}> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(orgId ? eq(auditEvents.orgId, orgId) : isNull(auditEvents.orgId))
    .orderBy(auditEvents.seq);
  return verifyChainRows(rows);
}

/**
 * Incrementally verify only rows appended since the last checkpoint, then
 * advance the checkpoint. O(new rows) per page load instead of O(whole chain).
 *
 * Caveat: a checkpoint attests "verified up to seq N once"; retroactive
 * tampering at or below N is only caught by a full `verifyChain`.
 */
export async function verifyChainIncremental(orgId: string | null): Promise<{
  ok: boolean;
  brokenAtSeq?: number;
}> {
  const chainScope = orgId ?? "global";
  const [checkpoint] = await db
    .select()
    .from(auditChainCheckpoints)
    .where(eq(auditChainCheckpoints.chainScope, chainScope));

  const scopeFilter = orgId ? eq(auditEvents.orgId, orgId) : isNull(auditEvents.orgId);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(
      checkpoint
        ? and(scopeFilter, gt(auditEvents.seq, checkpoint.verifiedThroughSeq))
        : scopeFilter,
    )
    .orderBy(auditEvents.seq);

  const result = verifyChainRows(rows, checkpoint?.hash ?? GENESIS);
  if (!result.ok) return { ok: false, brokenAtSeq: result.brokenAtSeq };

  if (result.lastSeq !== undefined && result.lastHash !== undefined) {
    await db
      .insert(auditChainCheckpoints)
      .values({
        chainScope,
        verifiedThroughSeq: result.lastSeq,
        hash: result.lastHash,
      })
      .onConflictDoUpdate({
        target: auditChainCheckpoints.chainScope,
        set: {
          verifiedThroughSeq: result.lastSeq,
          hash: result.lastHash,
          updatedAt: new Date(),
        },
      });
  }
  return { ok: true };
}

export async function listAuditEvents(
  orgId: string,
  opts: { limit?: number; beforeSeq?: number } = {},
) {
  const limit = opts.limit ?? 100;
  const where =
    opts.beforeSeq !== undefined
      ? and(eq(auditEvents.orgId, orgId), lt(auditEvents.seq, opts.beforeSeq))
      : eq(auditEvents.orgId, orgId);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { events: rows.slice(0, limit), hasMore };
}

export async function listAuditEventsForTarget(targetType: string, targetId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.targetType, targetType), eq(auditEvents.targetId, targetId)),
    )
    .orderBy(desc(auditEvents.createdAt));
}
