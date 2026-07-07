import "server-only";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { db } from "@/db";
import { smsEvents } from "@/db/schema";

/**
 * SMS delivery via AWS SNS with per-tenant usage tracking. Only the last
 * three digits of the recipient number are recorded in sms_events.
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
}): Promise<void> {
  const suffix = opts.to.slice(-3);
  if (process.env.SMS_ENABLED !== "true") {
    console.warn(`[sms:dev] to=***${suffix} message="${opts.message}"`);
    await db.insert(smsEvents).values({
      orgId: opts.orgId,
      recipientSuffix: suffix,
      status: "skipped_dev",
    });
    return;
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
  } catch (err) {
    await db.insert(smsEvents).values({
      orgId: opts.orgId,
      recipientSuffix: suffix,
      status: "failed",
    });
    throw err;
  }
}
