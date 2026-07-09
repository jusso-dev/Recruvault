import { Inngest } from "inngest";
import { z } from "zod";

/**
 * Typed event catalogue. Each event has a zod schema used for both
 * compile-time typing (via `sendEvent`) and runtime validation (via
 * `parseEvent` in handlers), replacing the previous `as` casts.
 */
export const eventSchemas = {
  "request/send": z.object({
    requestId: z.string().uuid(),
    recipientEmail: z.string().email(),
    recipientPhone: z.string().optional(),
    sentBy: z.string(),
  }),
  "document/uploaded": z.object({
    documentId: z.string().uuid(),
    table: z.enum(["documents", "wallet_documents"]),
  }),
  "email/event": z.object({
    type: z.string(),
    email: z.string(),
    messageId: z.string().optional(),
  }),
  "submission/received": z.object({
    submissionId: z.string().uuid(),
  }),
  "retention/purge.submission": z.object({
    submissionId: z.string().uuid(),
  }),
} as const;

export type EventName = keyof typeof eventSchemas;
export type EventData<K extends EventName> = z.infer<(typeof eventSchemas)[K]>;

export const inngest = new Inngest({ id: "recruvault" });

/** Type-checked event send. Payload shape is enforced at the call site. */
export function sendEvent<K extends EventName>(name: K, data: EventData<K>) {
  return inngest.send({ name, data });
}

/** Type-checked batch send for a single event type. */
export function sendEvents<K extends EventName>(name: K, items: EventData<K>[]) {
  return inngest.send(items.map((data) => ({ name, data })));
}

/** Runtime-validate + type a handler's event payload. */
export function parseEvent<K extends EventName>(name: K, data: unknown): EventData<K> {
  return eventSchemas[name].parse(data) as EventData<K>;
}
