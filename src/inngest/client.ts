import { Inngest } from "inngest";

/**
 * Event catalogue:
 * - "request/send"       { requestId, recipientEmail, recipientPhone?, sentBy }
 * - "document/uploaded"  { documentId, table: "documents" | "wallet_documents" }
 * - "email/event"        { type, email, messageId? } (from the Resend webhook)
 * - "submission/received"{ submissionId }
 */
export const inngest = new Inngest({ id: "recruvault" });
