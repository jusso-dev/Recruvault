import "server-only";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { db } from "@/db";
import { smsEvents } from "@/db/schema";
import { getLogger } from "@/lib/logger";

const log = getLogger("sms");

/**
 * SMS delivery via AWS SNS with per-tenant usage tracking. Only the last
 * three digits of the recipient number are recorded in sms_events. The
 * message body carries a secure link, so it is never logged.
 *
 * @returns true when SNS accepted the message, false when SMS is disabled.
 */

let sns: SNSClient | undefined;
function client() {
  sns ??= new SNSClient({ region: process.env.AWS_REGION ?? "ap-southeast-2" });
  return sns;
}

export async function sendSms(opts: {
  orgId: string;
  to: string; // E.164
  message: string;
}): Promise<boolean> {
  const suffix = opts.to.slice(-3);
  if (process.env.SMS_ENABLED !== "true") {
    const status = process.env.NODE_ENV === "production" ? "skipped_disabled" : "skipped_dev";
    log.info({ orgId: opts.orgId, status }, "sms not sent (SMS_ENABLED is not true)");
    await db.insert(smsEvents).values({
      orgId: opts.orgId,
      recipientSuffix: suffix,
      status,
    });
    return false;
  }

  try {
    await client().send(
      new PublishCommand({
        PhoneNumber: opts.to,
        Message: opts.message,
        MessageAttributes: {
          "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
        },
      }),
    );
    await db.insert(smsEvents).values({
      orgId: opts.orgId,
      recipientSuffix: suffix,
      status: "sent",
    });
    return true;
  } catch (err) {
    await db.insert(smsEvents).values({
      orgId: opts.orgId,
      recipientSuffix: suffix,
      status: "failed",
    });
    throw err;
  }
}
