import { createHmac, randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupMigratedDatabase } from "./harness";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * /api/inngest in production (cloud) mode: only requests signed with the
 * deployment signing key reach a function, and a captured signature cannot be
 * replayed after its five-minute window. The browser suite runs the dev
 * server, where Inngest deliberately accepts unsigned calls, so this property
 * is checked here against the real route handler.
 */

const KEY_HEX = randomBytes(32).toString("hex");
const SIGNING_KEY = `signkey-test-${KEY_HEX}`;
const FUNCTION_URL = "http://localhost:3000/api/inngest?fnId=recruvault-publish-outbox&stepId=step";

let stop: () => Promise<void>;
let route: typeof import("@/app/api/inngest/route");
const saved: Record<string, string | undefined> = {};

// The SDK signs the canonical JSON (RFC 8785, sorted keys) of the parsed body.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sign(body: string, key: string, ts = Math.floor(Date.now() / 1000)) {
  const s = createHmac("sha256", key).update(canonical(JSON.parse(body))).update(String(ts)).digest("hex");
  return `t=${ts}&s=${s}`;
}

const callBody = JSON.stringify({
  ctx: { attempt: 0, fn_id: "recruvault-publish-outbox", run_id: "01TESTRUN", step_id: "step", stack: { stack: [], current: 0 } },
  event: { name: "inngest/scheduled.timer", data: {} },
  events: [{ name: "inngest/scheduled.timer", data: {} }],
  steps: {},
  version: 2,
  use_api: false,
});

async function post(headers: Record<string, string>) {
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(FUNCTION_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: callBody,
  });
  return route.POST(request, {} as never);
}

beforeAll(async () => {
  for (const name of ["INNGEST_DEV", "INNGEST_SIGNING_KEY", "INNGEST_SIGNING_KEY_FALLBACK"]) saved[name] = process.env[name];
  process.env.LOCAL_KEK = "4f".repeat(32);
  process.env.INNGEST_DEV = "0";
  process.env.INNGEST_SIGNING_KEY = SIGNING_KEY;
  delete process.env.INNGEST_SIGNING_KEY_FALLBACK;
  ({ stop } = await setupMigratedDatabase());
  route = await import("@/app/api/inngest/route");
});

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await stop?.();
});

describe("inngest endpoint in cloud mode", () => {
  it("rejects unsigned, wrongly signed, tampered, and replayed calls", async () => {
    const otherKey = randomBytes(32).toString("hex");
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    const cases: [string, Record<string, string>][] = [
      ["unsigned", {}],
      ["malformed", { "x-inngest-signature": "not-a-signature" }],
      ["wrong key", { "x-inngest-signature": sign(callBody, otherKey) }],
      ["signed for another body", { "x-inngest-signature": sign("{}", KEY_HEX) }],
      ["replayed after the window", { "x-inngest-signature": sign(callBody, KEY_HEX, fiveMinutesAgo) }],
    ];
    for (const [label, headers] of cases) {
      const response = await post(headers);
      expect(response.status, label).toBeGreaterThanOrEqual(400);
      expect(await response.text(), label).not.toContain(KEY_HEX);
    }
  });

  it("accepts a freshly signed call, so the rejections are not vacuous", async () => {
    const response = await post({ "x-inngest-signature": sign(callBody, KEY_HEX) });
    expect(response.status).toBeLessThan(300);
  });
});
