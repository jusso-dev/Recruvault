import { Inngest } from "inngest";
import { z } from "zod";

/**
 * Typed event catalogue. Each event has a zod schema used for both
 * compile-time typing (via `enqueueEvent` in lib/outbox) and runtime
 * validation (via `parseEvent` in handlers). Payloads carry ids only: no
 * contact details, links, or key material. Events are published only through
 * the transactional outbox, so there is no direct send helper here.
 */
export const eventSchemas = {
  "request/send": z.object({
    requestId: z.string().uuid(),
    // The queued delivery row holds the recipient. Rows enqueued before this
    // change carry recipientEmail/recipientPhone instead; the consumer turns
    // them into a delivery row first.
    deliveryId: z.string().uuid().optional(),
    recipientEmail: z.string().email().optional(),
    recipientPhone: z.string().optional(),
    sentBy: z.string(),
  }),
  "document/uploaded": z.object({
    documentId: z.string().uuid(),
    table: z.enum(["documents", "wallet_documents"]),
  }),
  // Legacy: the Resend webhook now updates suppressions in its own
  // transaction. Kept so rows queued before that change still drain.
  "email/event": z.object({
    type: z.string(),
    email: z.string(),
    messageId: z.string().optional(),
  }),
  "submission/received": z.object({
    submissionId: z.string().uuid(),
  }),
  "job-alert/role-listed": z.object({
    requestId: z.string().uuid(),
  }),
  "job-alert/subscription-updated": z.object({
    candidateAccountId: z.string().uuid(),
  }),
  "retention/purge.submission": z.object({
    submissionId: z.string().uuid(),
  }),
} as const;

export type EventName = keyof typeof eventSchemas;
export type EventData<K extends EventName> = z.infer<(typeof eventSchemas)[K]>;

export const inngest = new Inngest({ id: "recruvault" });

/** Runtime-validate + type a handler's event payload. */
export function parseEvent<K extends EventName>(name: K, data: unknown): EventData<K> {
  return eventSchemas[name].parse(data) as EventData<K>;
}
