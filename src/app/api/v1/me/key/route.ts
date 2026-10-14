import { NextRequest } from "next/server";
import { describeApiKey } from "@/lib/api-auth";
import { handle, json } from "@/lib/api/http";

/** Describe the presented API key: kind, scopes, and expiry. Never key material. */
export async function GET(req: NextRequest) {
  return handle(async () => json({ key: await describeApiKey(req) }), req);
}
