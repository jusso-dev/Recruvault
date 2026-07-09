import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory cookie jar standing in for next/headers.
const store = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (store.has(n) ? { value: store.get(n) } : undefined),
    set: (n: string, v: string) => void store.set(n, v),
    delete: (n: string) => void store.delete(n),
  }),
}));

const { issueLinkSession, readLinkSession, clearLinkSession } = await import(
  "@/lib/link-session"
);

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
