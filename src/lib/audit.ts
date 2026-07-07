import "server-only";
import { createHash } from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents } from "@/db/schema";

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

function eventHash(prevHash: string, seq: number, e: AuditInput, at: string): string {
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
    });
  });
}

/** Verify the integrity of an organisation's audit chain. */
export async function verifyChain(orgId: string | null): Promise<{
  ok: boolean;
  brokenAtSeq?: number;
}> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(orgId ? eq(auditEvents.orgId, orgId) : isNull(auditEvents.orgId))
    .orderBy(auditEvents.seq);

  let prev = GENESIS;
  for (const row of rows) {
    if (row.prevHash !== prev) return { ok: false, brokenAtSeq: row.seq };
    prev = row.hash;
  }
  return { ok: true };
}

export async function listAuditEvents(orgId: string, limit = 200) {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.orgId, orgId))
    .orderBy(desc(auditEvents.seq))
    .limit(limit);
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
