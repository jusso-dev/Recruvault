import "server-only";
import { Resend } from "resend";

/**
 * Resend Domains API for custom sending-domain verification (SPF/DKIM). The
 * DNS records are surfaced to the org admin; verification status flips
 * organisations.sendingDomainVerifiedAt once DNS is in place.
 */

let resend: Resend | undefined;
function client(): Resend {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required to manage sending domains.");
  }
  resend ??= new Resend(process.env.RESEND_API_KEY);
  return resend;
}

export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl: string;
  status: string;
}

export function domainsEnabled(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export async function createSendingDomain(
  name: string,
): Promise<{ id: string; records: DnsRecord[] }> {
  const { data, error } = await client().domains.create({ name });
  if (error || !data) throw new Error(`Resend domain create failed: ${error?.message}`);
  return { id: data.id, records: (data.records ?? []) as DnsRecord[] };
}

export async function getSendingDomain(
  id: string,
): Promise<{ status: string; records: DnsRecord[] } | null> {
  const { data, error } = await client().domains.get(id);
  if (error || !data) return null;
  return { status: data.status, records: (data.records ?? []) as DnsRecord[] };
}

export async function verifySendingDomain(id: string): Promise<void> {
  const { error } = await client().domains.verify(id);
  if (error) throw new Error(`Resend domain verify failed: ${error.message}`);
}

export async function removeSendingDomain(id: string): Promise<void> {
  try {
    await client().domains.remove(id);
  } catch {
    // Best-effort cleanup; ignore.
  }
}
