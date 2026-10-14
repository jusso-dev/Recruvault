import { randomBytes, randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  accessTokens,
  deliveries,
  documents,
  organisations,
  outboxEvents,
  requests,
  submissions,
  user,
} from "@/db/schema";
import { setupMigratedDatabase } from "./harness";

let stop: () => Promise<void>;
let db: typeof import("@/db").db;
let outbox: typeof import("@/lib/outbox");
let service: typeof import("@/lib/requests-service");
let worker: typeof import("@/lib/delivery-worker");
let linkToken: typeof import("@/lib/link-token");
let vaultStore: typeof import("@/lib/vault-store");

beforeAll(async () => {
  ({ db, stop } = await setupMigratedDatabase());
  outbox = await import("@/lib/outbox");
  service = await import("@/lib/requests-service");
  worker = await import("@/lib/delivery-worker");
  linkToken = await import("@/lib/link-token");
  vaultStore = await import("@/lib/vault-store");
});

afterAll(async () => {
  await stop?.();
});

type Sent = { id: string; name: string; data: unknown };

async function drainAll(send: (event: Sent) => Promise<unknown>) {
  // Make every row due, then publish until nothing is left.
  await db.update(outboxEvents).set({ availableAt: new Date(0) }).where(eq(outboxEvents.state, "pending"));
  let total = 0;
  for (;;) {
    const n = await outbox.publishPendingOutbox(send, 100);
    total += n;
    if (n === 0) return total;
  }
}

async function seedRequest({ vault = true } = {}) {
  const userId = `user-${randomUUID()}`;
  await db.insert(user).values({
    id: userId,
    name: "Recruiter",
    email: `${userId}@example.org`,
    emailVerified: true,
    accountType: "org",
  });
  const [org] = await db
    .insert(organisations)
    .values({ name: "Acme", slug: `acme-${randomUUID()}` })
    .returning({ id: organisations.id });
  if (vault) {
    await vaultStore.insertVaultKey(db, { ownerType: "organisation", ownerId: org.id, crk: randomBytes(32) });
  }
  const [request] = await db
    .insert(requests)
    .values({ orgId: org.id, createdBy: userId, title: "Engineer", status: "open" })
    .returning();
  return { userId, orgId: org.id, request };
}

describe("transactional outbox", () => {
  it("commits the event with the domain write and never without it", async () => {
    const committedKey = `test/commit:${randomUUID()}`;
    const slug = `outbox-${randomUUID()}`;
    await db.transaction(async (tx) => {
      await tx.insert(organisations).values({ name: "Committed", slug });
      await outbox.enqueueEvent(tx, "submission/received", { submissionId: randomUUID() }, committedKey);
    });

    const rolledBackKey = `test/rollback:${randomUUID()}`;
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(organisations).values({ name: "Rolled back", slug: `${slug}-rb` });
        await outbox.enqueueEvent(tx, "submission/received", { submissionId: randomUUID() }, rolledBackKey);
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");

    const rows = await db
      .select({ dedupeKey: outboxEvents.dedupeKey })
      .from(outboxEvents)
      .where(inArray(outboxEvents.dedupeKey, [committedKey, rolledBackKey]));
    expect(rows.map((r) => r.dedupeKey)).toEqual([committedKey]);
  });

  it("publishes a committed-but-unpublished event exactly once from the cron path", async () => {
    // Process "dies" after commit: nothing publishes inline.
    const key = `test/crash:${randomUUID()}`;
    await outbox.enqueueEvent(db, "submission/received", { submissionId: randomUUID() }, key);

    const sent: Sent[] = [];
    const send = async (event: Sent) => void sent.push(event);
    await drainAll(send);
    await drainAll(send);

    const mine = sent.filter((event) => event.id === key);
    expect(mine).toHaveLength(1);
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, key));
    expect(row.state).toBe("published");
  });

  it("never double-sends under concurrent publishers", async () => {
    const keys = Array.from({ length: 40 }, () => `test/concurrent:${randomUUID()}`);
    for (const key of keys) {
      await outbox.enqueueEvent(db, "submission/received", { submissionId: randomUUID() }, key);
    }
    const counts = new Map<string, number>();
    const slowSend = async (event: Sent) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
    };
    await Promise.all(Array.from({ length: 6 }, () => outbox.publishPendingOutbox(slowSend, 15)));
    await Promise.all(Array.from({ length: 6 }, () => outbox.publishPendingOutbox(slowSend, 15)));

    for (const key of keys) expect(counts.get(key)).toBe(1);
  });

  it("retries with the same event id, dead-letters, and lets an operator requeue", async () => {
    const key = `test/dead:${randomUUID()}`;
    await outbox.enqueueEvent(db, "submission/received", { submissionId: randomUUID() }, key);
    const ids: string[] = [];
    const failing = async (event: Sent) => {
      if (event.id === key) {
        ids.push(event.id);
        throw new Error(`inngest unreachable for ${"someone@example.org"}`);
      }
    };
    await drainAll(failing);
    const [afterOne] = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, key));
    expect(afterOne.state).toBe("pending");
    expect(afterOne.attempts).toBe(1);
    expect(afterOne.availableAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(afterOne.lastError).not.toContain("someone@example.org");

    await db
      .update(outboxEvents)
      .set({ attempts: outbox.MAX_ATTEMPTS - 1 })
      .where(eq(outboxEvents.dedupeKey, key));
    await drainAll(failing);
    expect(new Set(ids)).toEqual(new Set([key]));
    const [dead] = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, key));
    expect(dead.state).toBe("dead");

    const listed = await outbox.listOutbox({ state: "dead", limit: 500 });
    const entry = listed.find((row) => row.id === dead.id);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("payload");
    expect(entry).not.toHaveProperty("dedupeKey");
    expect((await outbox.outboxStats()).dead).toBeGreaterThan(0);

    expect(await outbox.requeueDead([dead.id])).toBe(1);
    const sent: Sent[] = [];
    await drainAll(async (event) => void sent.push(event));
    expect(sent.filter((event) => event.id === key)).toHaveLength(1);
    const [published] = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, key));
    expect(published.state).toBe("published");
  });

  it("uses a bounded backoff that spans about a day", () => {
    const delays = Array.from({ length: outbox.MAX_ATTEMPTS - 1 }, (_, i) => outbox.retryDelaySeconds(i + 1));
    expect(Math.max(...delays)).toBe(3600);
    const total = delays.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThan(20 * 3600);
    expect(total).toBeLessThan(30 * 3600);
  });

  it("prunes published rows after 7 days and dead rows after 30", async () => {
    const day = 86_400_000;
    const now = Date.now();
    const [oldPublished, recentPublished, oldDead, recentDead] = await db
      .insert(outboxEvents)
      .values([
        { eventName: "submission/received", payload: {}, dedupeKey: `prune:${randomUUID()}`, state: "published", publishedAt: new Date(now - 8 * day) },
        { eventName: "submission/received", payload: {}, dedupeKey: `prune:${randomUUID()}`, state: "published", publishedAt: new Date(now - day) },
        { eventName: "submission/received", payload: {}, dedupeKey: `prune:${randomUUID()}`, state: "dead", createdAt: new Date(now - 31 * day) },
        { eventName: "submission/received", payload: {}, dedupeKey: `prune:${randomUUID()}`, state: "dead", createdAt: new Date(now - 2 * day) },
      ])
      .returning({ id: outboxEvents.id });
    await outbox.pruneOutbox();
    const left = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(inArray(outboxEvents.id, [oldPublished.id, recentPublished.id, oldDead.id, recentDead.id]));
    expect(left.map((row) => row.id).sort()).toEqual([recentPublished.id, recentDead.id].sort());
  });

  it("reconciles committed work that has no event", async () => {
    const { orgId } = await seedRequest();
    const [doc] = await db
      .insert(documents)
      .values({ orgId, kind: "evidence", fileName: "x.pdf", contentType: "application/pdf", storageKey: `org/${randomUUID()}` })
      .returning({ id: documents.id });
    expect(await outbox.reconcileOutbox()).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupeKey, `document/uploaded:documents:${doc.id}`));
    expect(rows).toHaveLength(1);
    await outbox.reconcileOutbox();
    const again = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupeKey, `document/uploaded:documents:${doc.id}`));
    expect(again).toHaveLength(1);
  });
});

describe("consumer idempotency", () => {
  it("runs a side effect once per key, even for duplicate or concurrent deliveries", async () => {
    const key = `test:${randomUUID()}`;
    let runs = 0;
    const effect = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      runs += 1;
    };
    const concurrent = await Promise.allSettled([outbox.consumeOnce(key, effect), outbox.consumeOnce(key, effect)]);
    expect(runs).toBe(1);
    expect(concurrent.filter((r) => r.status === "fulfilled" && r.value === "ran")).toHaveLength(1);
    const other = concurrent.find((r) => !(r.status === "fulfilled" && r.value === "ran"));
    expect(
      other?.status === "rejected" ? other.reason : other?.status === "fulfilled" ? other.value : null,
    ).toSatisfy((value: unknown) => value === "duplicate" || value instanceof outbox.ConsumerBusyError);

    expect(await outbox.consumeOnce(key, effect)).toBe("duplicate");
    expect(runs).toBe(1);
  });

  it("releases the claim when the side effect fails so a retry runs it", async () => {
    const key = `test:${randomUUID()}`;
    let runs = 0;
    await expect(
      outbox.consumeOnce(key, async () => {
        runs += 1;
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    expect(await outbox.consumeOnce(key, async () => void (runs += 1))).toBe("ran");
    expect(runs).toBe(2);
  });
});

describe("request delivery", () => {
  it("queues token, delivery, and an id-only event in one commit, and a retried submit reuses it", async () => {
    const { userId, orgId, request } = await seedRequest();
    const email = `candidate-${randomUUID()}@example.org`;
    const first = await service.queueRequestDelivery({ orgId, sentBy: userId, request, recipientEmail: email, recipientPhone: "+61412345678" });
    const retry = await service.queueRequestDelivery({ orgId, sentBy: userId, request, recipientEmail: email.toUpperCase() });
    expect(retry.duplicate).toBe(true);
    expect(retry.deliveryId).toBe(first.deliveryId);

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, `request/send:${first.deliveryId}`));
    expect(event.payload).toEqual({ requestId: request.id, deliveryId: first.deliveryId, sentBy: userId });
    expect(JSON.stringify(event)).not.toContain(email);
    expect(JSON.stringify(event)).not.toContain("412345678");

    const [token] = await db.select().from(accessTokens).where(eq(accessTokens.id, first.accessTokenId));
    expect(token.tokenHash).toBe(linkToken.deliveryLinkToken(first.accessTokenId).tokenHash);
  });

  it("sends one invitation and one SMS however often the event is replayed", async () => {
    const { userId, orgId, request } = await seedRequest();
    const email = `candidate-${randomUUID()}@example.org`;
    const queued = await service.queueRequestDelivery({ orgId, sentBy: userId, request, recipientEmail: email, recipientPhone: "+61412345678" });

    const invites: string[] = [];
    const sendInvite = (async (opts: { link: string }) => {
      invites.push(opts.link);
      return `msg-${randomUUID()}`;
    }) as Parameters<typeof worker.sendDeliveryEmail>[1];
    const sms: string[] = [];
    const sendSms = (async (opts: { message: string }) => {
      sms.push(opts.message);
      return true;
    }) as Parameters<typeof worker.sendDeliverySms>[1];

    expect(await worker.sendDeliveryEmail(queued.deliveryId, sendInvite)).toBe("sent");
    expect(await worker.sendDeliveryEmail(queued.deliveryId, sendInvite)).toBe("duplicate");
    expect(await worker.sendDeliverySms(queued.deliveryId, sendSms)).toBe("sent");
    expect(await worker.sendDeliverySms(queued.deliveryId, sendSms)).toBe("duplicate");
    expect(invites).toHaveLength(1);
    expect(sms).toHaveLength(1);

    // The emailed link is the one the token row accepts.
    const token = invites[0].split("/r/")[1];
    const [row] = await db.select().from(accessTokens).where(eq(accessTokens.id, queued.accessTokenId));
    expect(row.tokenHash).toBe(linkToken.deliveryLinkToken(queued.accessTokenId).tokenHash);
    expect(token).toBe(linkToken.deliveryLinkToken(queued.accessTokenId).token);

    const rows = await db.select().from(deliveries).where(eq(deliveries.accessTokenId, queued.accessTokenId));
    expect(rows.map((r) => `${r.channel}:${r.status}`).sort()).toEqual(["email:sent", "sms:sent"]);
  });

  it("does not report an unsent invitation as delivered", async () => {
    const { userId, orgId, request } = await seedRequest();
    const queued = await service.queueRequestDelivery({
      orgId,
      sentBy: userId,
      request,
      recipientEmail: `candidate-${randomUUID()}@example.org`,
    });
    const notSent = (async () => null) as Parameters<typeof worker.sendDeliveryEmail>[1];
    expect(await worker.sendDeliveryEmail(queued.deliveryId, notSent)).toBe("not_sent");
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, queued.deliveryId));
    expect(row.status).toBe("failed");
  });

  it("fails closed when the organisation has no usable vault", async () => {
    const { userId, orgId, request } = await seedRequest({ vault: false });
    const queued = await service.queueRequestDelivery({
      orgId,
      sentBy: userId,
      request,
      recipientEmail: `candidate-${randomUUID()}@example.org`,
      recipientPhone: "+61412345678",
    });
    let sends = 0;
    const count = (async () => {
      sends += 1;
      return "msg";
    }) as unknown as Parameters<typeof worker.sendDeliveryEmail>[1];
    expect(await worker.sendDeliveryEmail(queued.deliveryId, count)).toBe("skipped");
    expect(await worker.sendDeliverySms(queued.deliveryId, count as never)).toBe("skipped");
    expect(sends).toBe(0);
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, queued.deliveryId));
    expect(row.status).toBe("failed");
  });

  it("notifies the recruiter once per submission", async () => {
    const { request } = await seedRequest();
    const [submission] = await db
      .insert(submissions)
      .values({ requestId: request.id, status: "received", submittedAt: new Date() })
      .returning({ id: submissions.id });
    const alerts: string[] = [];
    const sendAlert = (async (opts: { reviewUrl: string }) => {
      alerts.push(opts.reviewUrl);
      return "msg";
    }) as Parameters<typeof worker.notifySubmissionReceived>[1];
    expect(await worker.notifySubmissionReceived(submission.id, sendAlert)).toBe("sent");
    expect(await worker.notifySubmissionReceived(submission.id, sendAlert)).toBe("duplicate");
    expect(alerts).toHaveLength(1);
    const ledger = await db
      .select()
      .from(outboxEvents)
      .where(and(like(outboxEvents.dedupeKey, "consumed:%"), eq(outboxEvents.state, "consumed")));
    expect(ledger.length).toBeGreaterThan(0);
  });
});
