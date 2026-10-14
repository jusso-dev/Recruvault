import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { outboxEvents } from "@/db/schema";
import { eventSchemas, inngest, type EventData, type EventName } from "@/inngest/client";
import { sanitizeForTelemetry } from "@/lib/redact";
import { getLogger } from "@/lib/logger";

/**
 * Transactional outbox. Domain writes insert their event row in the same
 * transaction (`enqueueEvent(tx, ...)`); publication happens after commit, by
 * the request that wrote it (best effort) and by the publish-outbox cron.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED` and a lease on `available_at`,
 * so concurrent publishers never send the same row at the same time. A crash
 * after send but before the row is marked re-sends it after the lease with the
 * same event id (the dedupe key), which Inngest drops as a duplicate.
 *
 * States: pending -> published | dead. `consuming`/`consumed` rows are the
 * consumer idempotency ledger (see consumeOnce) and are never published.
 * No `import "server-only"` so the operator CLI (scripts/outbox.ts) can load it.
 */

type Executor = Pick<typeof db, "insert">;

const log = getLogger("outbox");

export const MAX_ATTEMPTS = 30;
const LEASE_MS = 5 * 60_000;
const CONSUME_LEASE_MS = 10 * 60_000;
const PUBLISHED_RETENTION_DAYS = 7;
const DEAD_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** 30s doubling to a 1h cap. 30 attempts span roughly a day of outage. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

export async function enqueueEvent<K extends EventName>(
  executor: Executor,
  name: K,
  data: EventData<K>,
  dedupeKey: string,
  ownerScope?: string | null,
) {
  // Validate before commit so a malformed payload fails the domain write
  // instead of dead-lettering later.
  eventSchemas[name].parse(data);
  await executor
    .insert(outboxEvents)
    .values({
      eventName: name,
      eventVersion: 1,
      ownerScope: ownerScope ?? null,
      payload: data,
      dedupeKey,
      state: "pending",
    })
    .onConflictDoNothing({ target: outboxEvents.dedupeKey });
}

type Sender = (event: { id: string; name: string; data: unknown }) => Promise<unknown>;

const defaultSend: Sender = (event) => inngest.send(event);

/** Lease up to `limit` due rows to this publisher. */
async function claimDue(limit: number) {
  const now = new Date();
  const due = db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.state, "pending"), lte(outboxEvents.availableAt, now)))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  return db
    .update(outboxEvents)
    .set({ availableAt: new Date(now.getTime() + LEASE_MS) })
    .where(inArray(outboxEvents.id, due))
    .returning();
}

/**
 * Publish due outbox rows. Safe to run concurrently and more than once: the
 * event id is the dedupe key, and a row stays pending until the send succeeds.
 */
export async function publishPendingOutbox(send: Sender = defaultSend, limit = 50): Promise<number> {
  const claimed = await claimDue(limit);

  let published = 0;
  for (const row of claimed) {
    try {
      await send({ id: row.dedupeKey, name: row.eventName, data: row.payload });
      await db
        .update(outboxEvents)
        .set({ state: "published", publishedAt: new Date(), lastError: null })
        .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.state, "pending")));
      published += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const message = sanitizeForTelemetry(error instanceof Error ? error.message : "publish failed");
      await db
        .update(outboxEvents)
        .set({
          attempts,
          state: dead ? "dead" : "pending",
          lastError: String(message).slice(0, 240),
          availableAt: new Date(Date.now() + retryDelaySeconds(attempts) * 1000),
        })
        .where(eq(outboxEvents.id, row.id));
      if (dead) log.error({ outboxId: row.id, eventName: row.eventName, attempts }, "outbox event dead-lettered");
    }
  }
  return published;
}

/**
 * Best-effort publish after the domain transaction committed. Never throws:
 * the row is already durable and the cron publishes it if this fails.
 */
export async function publishAfterCommit(): Promise<void> {
  try {
    await publishPendingOutbox();
  } catch (error) {
    log.warn({ err: error }, "inline outbox publish failed; cron will retry");
  }
}

/**
 * Record and publish an event that has no accompanying domain write. Anything
 * that changes rows must call enqueueEvent inside its own transaction instead.
 */
export async function emitEvent<K extends EventName>(
  name: K,
  data: EventData<K>,
  dedupeKey: string,
  ownerScope?: string | null,
) {
  await enqueueEvent(db, name, data, dedupeKey, ownerScope);
  await publishAfterCommit();
}

export class ConsumerBusyError extends Error {
  constructor() {
    super("Another worker is processing this event.");
    this.name = "ConsumerBusyError";
  }
}

/**
 * Run a consumer side effect at most once per key, even when the same event
 * is delivered again. A crashed attempt releases its claim after a lease, so
 * the work is retried rather than lost (at-least-once for crashes during the
 * side effect itself). Concurrent duplicates get ConsumerBusyError, which is
 * retryable.
 *
 * @returns "ran" when fn executed now, "duplicate" when it already completed.
 */
export async function consumeOnce(
  key: string,
  fn: () => Promise<void>,
): Promise<"ran" | "duplicate"> {
  const dedupeKey = `consumed:${key}`;
  const now = new Date();
  const lease = new Date(now.getTime() + CONSUME_LEASE_MS);
  const [claimed] = await db
    .insert(outboxEvents)
    .values({ eventName: "consumer/ledger", payload: {}, dedupeKey, state: "consuming", availableAt: lease })
    .onConflictDoUpdate({
      target: outboxEvents.dedupeKey,
      set: { availableAt: lease, attempts: sql`${outboxEvents.attempts} + 1` },
      // Take over only an abandoned claim.
      setWhere: and(eq(outboxEvents.state, "consuming"), lte(outboxEvents.availableAt, now)),
    })
    .returning({ id: outboxEvents.id });
  if (!claimed) {
    const [existing] = await db
      .select({ state: outboxEvents.state })
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupeKey, dedupeKey));
    if (existing?.state === "consumed") return "duplicate";
    throw new ConsumerBusyError();
  }
  try {
    await fn();
  } catch (error) {
    await db.delete(outboxEvents).where(and(eq(outboxEvents.id, claimed.id), eq(outboxEvents.state, "consuming")));
    throw error;
  }
  await db
    .update(outboxEvents)
    .set({ state: "consumed", publishedAt: new Date() })
    .where(eq(outboxEvents.id, claimed.id));
  return "ran";
}

export interface OutboxStats {
  pending: number;
  due: number;
  dead: number;
  oldestPendingSeconds: number;
}

export async function outboxStats(): Promise<OutboxStats> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${outboxEvents.state} = 'pending')::int`,
      due: sql<number>`count(*) filter (where ${outboxEvents.state} = 'pending' and ${outboxEvents.availableAt} <= ${new Date()})::int`,
      dead: sql<number>`count(*) filter (where ${outboxEvents.state} = 'dead')::int`,
      oldest: sql<Date | null>`min(${outboxEvents.createdAt}) filter (where ${outboxEvents.state} = 'pending')`,
    })
    .from(outboxEvents);
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    pending: row?.pending ?? 0,
    due: row?.due ?? 0,
    dead: row?.dead ?? 0,
    oldestPendingSeconds: oldest ? Math.max(0, Math.round((Date.now() - oldest.getTime()) / 1000)) : 0,
  };
}

/** Kept for existing callers. */
export async function outboxDepth(): Promise<{ pending: number; dead: number }> {
  const { pending, dead } = await outboxStats();
  return { pending, dead };
}

/** Operator listing. Metadata only: never the payload or dedupe key. */
export async function listOutbox(opts: { state?: string; limit?: number } = {}) {
  return db
    .select({
      id: outboxEvents.id,
      eventName: outboxEvents.eventName,
      eventVersion: outboxEvents.eventVersion,
      ownerScope: outboxEvents.ownerScope,
      state: outboxEvents.state,
      attempts: outboxEvents.attempts,
      availableAt: outboxEvents.availableAt,
      createdAt: outboxEvents.createdAt,
      publishedAt: outboxEvents.publishedAt,
      lastError: outboxEvents.lastError,
    })
    .from(outboxEvents)
    .where(eq(outboxEvents.state, opts.state ?? "dead"))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(opts.limit ?? 50);
}

/** Return dead rows to the queue with a fresh attempt budget. */
export async function requeueDead(ids?: string[]): Promise<number> {
  const rows = await db
    .update(outboxEvents)
    .set({ state: "pending", attempts: 0, availableAt: new Date(), lastError: null })
    .where(
      ids && ids.length > 0
        ? and(eq(outboxEvents.state, "dead"), inArray(outboxEvents.id, ids))
        : eq(outboxEvents.state, "dead"),
    )
    .returning({ id: outboxEvents.id });
  return rows.length;
}

/** Bound table growth: published rows after 7 days, dead and ledger rows after 30. */
export async function pruneOutbox(now = new Date()): Promise<number> {
  const publishedBefore = new Date(now.getTime() - PUBLISHED_RETENTION_DAYS * DAY_MS);
  const deadBefore = new Date(now.getTime() - DEAD_RETENTION_DAYS * DAY_MS);
  const rows = await db
    .delete(outboxEvents)
    .where(
      or(
        and(eq(outboxEvents.state, "published"), lt(outboxEvents.publishedAt, publishedBefore)),
        and(inArray(outboxEvents.state, ["dead", "consumed"]), lt(outboxEvents.createdAt, deadBefore)),
      ),
    )
    .returning({ id: outboxEvents.id });
  return rows.length;
}

/**
 * Re-create events for committed work that has no outbox row: unscanned
 * plaintext documents and recent submissions without a received event. Rows
 * written before the outbox existed are the main source.
 */
export async function reconcileOutbox(limit = 100): Promise<number> {
  const recent = new Date(Date.now() - 7 * DAY_MS);
  const missing = await db.execute<{ kind: string; id: string; owner: string | null }>(sql`
    (select 'documents' as kind, d.id::text as id, d.org_id::text as owner
       from documents d
      where d.scan_status = 'pending' and d.envelope_version = 0
        and not exists (select 1 from outbox_events o
                         where o.dedupe_key = 'document/uploaded:documents:' || d.id::text)
      limit ${limit})
    union all
    (select 'wallet_documents', w.id::text, w.candidate_account_id::text
       from wallet_documents w
      where w.scan_status = 'pending' and w.envelope_version = 0
        and not exists (select 1 from outbox_events o
                         where o.dedupe_key = 'document/uploaded:wallet_documents:' || w.id::text)
      limit ${limit})
    union all
    (select 'submissions', s.id::text, r.org_id::text
       from submissions s join requests r on r.id = s.request_id
      where s.status <> 'started' and s.submitted_at >= ${recent} and s.purged_at is null
        and not exists (select 1 from outbox_events o
                         where o.dedupe_key = 'submission/received:' || s.id::text)
      limit ${limit})
  `);
  let enqueued = 0;
  for (const row of missing.rows) {
    if (row.kind === "submissions") {
      await enqueueEvent(db, "submission/received", { submissionId: row.id }, `submission/received:${row.id}`, row.owner);
    } else {
      const table = row.kind as "documents" | "wallet_documents";
      await enqueueEvent(db, "document/uploaded", { documentId: row.id, table }, `document/uploaded:${table}:${row.id}`, row.owner);
    }
    enqueued += 1;
  }
  if (enqueued > 0) log.warn({ enqueued }, "outbox reconciliation re-created missing events");
  return enqueued;
}
