import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { candidateApiKeys, session } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { asBrowser, newBrowser, signUpVerified, type Browser } from "./request-context";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * Creating or rotating an API key needs a session under 15 minutes old or the
 * account password, checked through the real BetterAuth verifyPassword path.
 */

const PASSWORD = "correct-horse-battery";
const SEEKER_KEY = "Zx4Cv8Bn2Mq6Wr0Ty3Ui7Op1As5Df9Gh2Jk6Lz0Xc4V";

let db: typeof import("@/db").db;
let stop: () => Promise<void>;
let keys: typeof import("@/actions/api-keys");
let seeker: Browser;
let userId: string;

function form(values: Record<string, string | string[]>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(name, v);
  }
  return data;
}

async function ageSessions(minutes: number) {
  await db
    .update(session)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(session.userId, userId));
}

async function activeKeys() {
  const { requireCandidate } = await import("@/lib/guards");
  const ctx = await asBrowser(seeker, () => requireCandidate());
  const rows = await db
    .select({ id: candidateApiKeys.id, revokedAt: candidateApiKeys.revokedAt })
    .from(candidateApiKeys)
    .where(eq(candidateApiKeys.candidateAccountId, ctx.candidateAccountId));
  return rows.filter((row) => !row.revokedAt);
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "44".repeat(32);
  ({ db, stop } = await setupMigratedDatabase());
  keys = await import("@/actions/api-keys");
  const vault = await import("@/actions/vault");

  seeker = newBrowser();
  await signUpVerified(seeker, "keys-seeker@example.invalid");
  const { getSession, requireCandidate } = await import("@/lib/guards");
  userId = (await asBrowser(seeker, () => getSession()))!.user.id;
  // The seeker layout creates the candidate row before enrolment.
  await asBrowser(seeker, () => requireCandidate());
  const enrolled = await asBrowser(seeker, () =>
    vault.enrollVault(
      form({ keyMode: "import", encryptionKey: SEEKER_KEY, encryptionKeyConfirm: SEEKER_KEY, keyBackupAck: "yes" }),
    ),
  );
  expect(enrolled).toEqual({ ok: true });
});

afterAll(async () => {
  await stop?.();
});

describe("API key recent authentication", () => {
  it("allows a fresh session without a password", async () => {
    const result = await asBrowser(seeker, () =>
      keys.createCandidateApiKey(form({ name: "fresh", scopes: ["profile:read"] })),
    );
    expect(result.ok).toBe(true);
    expect(result.key).toMatch(/^rv_/);
  });

  it("refuses an older session without a password or with the wrong one", async () => {
    await ageSessions(30);
    const before = (await activeKeys()).length;
    const missing = await asBrowser(seeker, () =>
      keys.createCandidateApiKey(form({ name: "stale", scopes: ["profile:read"] })),
    );
    expect(missing.ok).toBe(false);
    expect(missing.key).toBeUndefined();
    const wrong = await asBrowser(seeker, () =>
      keys.createCandidateApiKey(form({ name: "stale", scopes: ["profile:read"], password: "not-the-password" })),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.key).toBeUndefined();
    expect((await activeKeys()).length).toBe(before);
  });

  it("accepts the account password on an older session, for create and rotate", async () => {
    await ageSessions(30);
    const created = await asBrowser(seeker, () =>
      keys.createCandidateApiKey(form({ name: "confirmed", scopes: ["profile:read"], password: PASSWORD })),
    );
    expect(created.ok).toBe(true);

    const refused = await asBrowser(seeker, () =>
      keys.rotateCandidateApiKey(form({ keyId: created.id! })),
    );
    expect(refused.ok).toBe(false);
    const rotated = await asBrowser(seeker, () =>
      keys.rotateCandidateApiKey(form({ keyId: created.id!, password: PASSWORD })),
    );
    expect(rotated.ok).toBe(true);
    const ids = (await activeKeys()).map((row) => row.id);
    expect(ids).toContain(rotated.id);
    expect(ids).not.toContain(created.id);
  });
});
