import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

/**
 * Resend webhook receiver (svix-signed). Bounce and complaint events flow
 * into Inngest, which maintains the suppression list.
 */

function verifySvix(req: NextRequest, payload: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";

  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signatures = req.headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  // Reject stale timestamps (5 minute tolerance).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  return signatures.split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function POST(req: NextRequest) {
  const payload = await req.text();
  if (!verifySvix(req, payload)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(payload) as {
    type: string;
    data?: { to?: string[] | string; email_id?: string };
  };

  const to = Array.isArray(body.data?.to) ? body.data?.to[0] : body.data?.to;
  if (to) {
    await inngest.send({
      name: "email/event",
      data: { type: body.type, email: to, messageId: body.data?.email_id },
    });
  }

  return NextResponse.json({ ok: true });
}
