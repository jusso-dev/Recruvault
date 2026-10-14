import "server-only";
import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { outboxEvents } from "@/db/schema";
import { inngest, type EventData, type EventName } from "@/inngest/client";
import { sanitizeForTelemetry } from "@/lib/redact";

type Executor = Pick<typeof db, "insert">;

const MAX_ATTEMPTS = 8;

export async function enqueueEvent<K extends EventName>(
  executor: Executor,
  name: K,
  data: EventData<K>,
  dedupeKey: string,
  ownerScope?: string | null,
) {
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

/**
 * Publish pending outbox rows. Safe to run more than once: the event id is the
 * dedupe key, and a row stays pending until the send succeeds.
 */
export async function publishPendingOutbox(send: Sender = defaultSend, limit = 50): Promise<number> {
  const due = await db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.state, "pending"), lte(outboxEvents.availableAt, new Date())))
    .orderBy(outboxEvents.createdAt)
    .limit(limit);

  let published = 0;
  for (const row of due) {
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
          availableAt: new Date(Date.now() + Math.min(60, 2 ** attempts) * 1000),
        })
        .where(eq(outboxEvents.id, row.id));
    }
  }
  return published;
}

/** Record an event and try to publish it. Callers that already have a transaction should use enqueueEvent inside it, then publishPendingOutbox. */
export async function emitEvent<K extends EventName>(
  name: K,
  data: EventData<K>,
  dedupeKey: string,
  ownerScope?: string | null,
) {
  await enqueueEvent(db, name, data, dedupeKey, ownerScope);
  await publishPendingOutbox();
}

export async function outboxDepth(): Promise<{ pending: number; dead: number }> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${outboxEvents.state} = 'pending')::int`,
      dead: sql<number>`count(*) filter (where ${outboxEvents.state} = 'dead')::int`,
    })
    .from(outboxEvents);
  return { pending: row?.pending ?? 0, dead: row?.dead ?? 0 };
}
