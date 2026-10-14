import "server-only";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db";
import { vaultKeys, vaultUnlocks } from "@/db/schema";
import { getSession } from "@/lib/guards";
import {
  newUnlockCookieSecret,
  openUnlockCookie,
  verifierMatches,
  wrapUnlockCookie,
} from "@/lib/vault-crypto";

const COOKIE = "rv_vault_wrap";

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

async function cookieSecret(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing && Buffer.from(existing, "base64url").length === 32) return existing;
  const created = newUnlockCookieSecret();
  jar.set(COOKIE, created, cookieOptions());
  return created;
}

/** Bind the customer key to this browser session. The raw key stays out of the database. */
export async function establishVaultUnlock(input: {
  vaultKeyId: string;
  crk: Buffer;
  sessionId: string;
  expiresAt: Date;
}) {
  const secret = await cookieSecret();
  await db
    .insert(vaultUnlocks)
    .values({
      vaultKeyId: input.vaultKeyId,
      sessionId: input.sessionId,
      wrappedCrk: wrapUnlockCookie(secret, input.crk),
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: [vaultUnlocks.sessionId, vaultUnlocks.vaultKeyId],
      set: {
        wrappedCrk: wrapUnlockCookie(secret, input.crk),
        expiresAt: input.expiresAt,
      },
    });
}

export async function readUnlockedCustomerKey(
  ownerType: string,
  ownerId: string,
): Promise<Buffer | undefined> {
  try {
    const jar = await cookies();
    const secret = jar.get(COOKIE)?.value;
    if (!secret) return undefined;
    const authSession = await getSession();
    if (!authSession) return undefined;
    const [row] = await db
      .select({
        wrappedCrk: vaultUnlocks.wrappedCrk,
        expiresAt: vaultUnlocks.expiresAt,
        verifier: vaultKeys.verifier,
        status: vaultKeys.status,
      })
      .from(vaultUnlocks)
      .innerJoin(vaultKeys, eq(vaultKeys.id, vaultUnlocks.vaultKeyId))
      .where(
        and(
          eq(vaultUnlocks.sessionId, authSession.session.id),
          eq(vaultKeys.ownerType, ownerType),
          eq(vaultKeys.ownerId, ownerId),
          eq(vaultKeys.status, "active"),
        ),
      );
    if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
    const crk = openUnlockCookie(secret, row.wrappedCrk);
    if (!verifierMatches(crk, ownerType, ownerId, row.verifier)) return undefined;
    return crk;
  } catch {
    return undefined;
  }
}

export async function currentSessionUnlock(): Promise<
  { sessionId: string; expiresAt: Date } | undefined
> {
  const authSession = await getSession();
  if (!authSession) return undefined;
  return { sessionId: authSession.session.id, expiresAt: authSession.session.expiresAt };
}
