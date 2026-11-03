import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory cookie jar standing in for next/headers.
const store = new Map<string, string>();
const options = new Map<string, Record<string, unknown>>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (store.has(n) ? { value: store.get(n) } : undefined),
    set: (n: string, v: string, o?: Record<string, unknown>) => {
      store.set(n, v);
      options.set(n, o ?? {});
    },
    delete: (n: string) => void store.delete(n),
  }),
}));

const { issueLinkSession, readLinkSession, clearLinkSession, ensureDraftSecret, readDraftSecret } =
  await import("@/lib/link-session");

const COOKIE = "rv_link_session";
const SECRET = process.env.LINK_SESSION_SECRET!;

function craft(accessTokenId: string, expires: number) {
  const payload = `${accessTokenId}.${expires}`;
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

describe("link session cookie (HMAC-signed)", () => {
  beforeEach(() => store.clear());

  it("issues a cookie that reads back to the access token id", async () => {
    await issueLinkSession("at-abc");
    expect(await readLinkSession()).toBe("at-abc");
  });

  it("returns null when no cookie is present", async () => {
    expect(await readLinkSession()).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    await issueLinkSession("at-abc");
    const raw = store.get(COOKIE)!;
    const [id, exp] = raw.split(".");
    store.set(COOKIE, `${id}.${exp}.forged-signature`);
    expect(await readLinkSession()).toBeNull();
  });

  it("rejects a swapped access-token id (signature no longer matches)", async () => {
    const raw = craft("at-abc", Date.now() + 60_000);
    const forged = raw.replace("at-abc", "at-evil");
    store.set(COOKIE, forged);
    expect(await readLinkSession()).toBeNull();
  });

  it("rejects an expired but validly-signed cookie", async () => {
    store.set(COOKIE, craft("at-abc", Date.now() - 1000));
    expect(await readLinkSession()).toBeNull();
  });

  it("rejects a malformed cookie", async () => {
    store.set(COOKIE, "only.two");
    expect(await readLinkSession()).toBeNull();
  });

  it("clears the cookie", async () => {
    await issueLinkSession("at-abc");
    await clearLinkSession();
    expect(await readLinkSession()).toBeNull();
  });
});

describe("draft secret cookie", () => {
  beforeEach(() => {
    store.clear();
    options.clear();
  });

  it("is random, httpOnly, named for the link, scoped to /r/, and lives as long as the link", async () => {
    const expires = new Date(Date.now() + 3 * 86_400_000);
    await ensureDraftSecret("at-abc", expires);
    const secret = await readDraftSecret("at-abc");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const set = options.get("rv_link_draft_at-abc")!;
    // Not the token path: an expiry reminder rotates the token for the same link.
    expect(set).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/r/" });
    expect(Number(set.maxAge)).toBeGreaterThan(3 * 86_400 - 5);
    expect(Number(set.maxAge)).toBeLessThanOrEqual(3 * 86_400);
  });

  it("is never replaced while it exists, so a re-verified responder keeps their draft", async () => {
    const expires = new Date(Date.now() + 86_400_000);
    await ensureDraftSecret("at-abc", expires);
    const first = await readDraftSecret("at-abc");
    await ensureDraftSecret("at-abc", expires);
    expect(await readDraftSecret("at-abc")).toBe(first);
  });

  it("belongs to one link and outlives the one-hour session", async () => {
    await issueLinkSession("at-abc");
    await ensureDraftSecret("at-abc", new Date(Date.now() + 86_400_000));
    expect(await readDraftSecret("at-other")).toBeNull();
    store.set(COOKIE, craft("at-abc", Date.now() - 1000));
    expect(await readLinkSession()).toBeNull();
    expect(await readDraftSecret("at-abc")).not.toBeNull();
  });

  it("is not issued for an expired link", async () => {
    await ensureDraftSecret("at-abc", new Date(Date.now() - 1000));
    expect(await readDraftSecret("at-abc")).toBeNull();
  });
});
