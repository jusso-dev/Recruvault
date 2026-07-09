import { NextRequest, NextResponse } from "next/server";
import { sendEvent } from "@/inngest/client";
import { verifySvixSignature } from "@/lib/svix";

/**
 * Resend webhook receiver (svix-signed). Bounce and complaint events flow
 * into Inngest, which maintains the suppression list.
 */

function verifySvix(req: NextRequest, payload: string): boolean {
  return verifySvixSignature(
    process.env.RESEND_WEBHOOK_SECRET,
    {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    payload,
  );
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
    await sendEvent("email/event", {
      type: body.type,
      email: to,
      messageId: body.data?.email_id,
    });
  }

  return NextResponse.json({ ok: true });
}
