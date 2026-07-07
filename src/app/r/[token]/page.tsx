import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, organisations, requests } from "@/db/schema";
import { sha256 } from "@/lib/crypto";
import { Card, CardContent } from "@/components/ui";
import { OtpVerify } from "./otp-verify";

/**
 * Secure link entry point. The token in the URL is opaque and single-purpose;
 * only its hash is stored. Before anything is shown, the responder must pass
 * OTP step-up to the email the recruiter specified — a forwarded link is
 * useless to the wrong person.
 */
export default async function SecureLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [at] = await db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, sha256(token)));

  function Shell({ children }: { children: React.ReactNode }) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
        <Card className="w-full max-w-md">
          <CardContent>{children}</CardContent>
        </Card>
      </main>
    );
  }

  if (!at) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">This link is not valid</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Check you copied the full link, or contact the recruiter who sent it.
        </p>
      </Shell>
    );
  }
  if (at.consumedAt) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Already completed</h1>
        <p className="mt-2 text-sm text-zinc-600">
          A response has already been submitted through this link. Secure links are
          single-purpose.
        </p>
      </Shell>
    );
  }
  if (at.expiresAt < new Date()) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">This link has expired</h1>
        <p className="mt-2 text-sm text-zinc-600">
          For your security, secure links stop working after their expiry. Ask the
          recruiter to send a new one.
        </p>
      </Shell>
    );
  }

  const [request] = await db.select().from(requests).where(eq(requests.id, at.requestId));
  const [org] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, request.orgId));

  // Mask the recipient email for display: j***@e***.com
  const [local, domain] = at.recipientEmail.split("@");
  const masked = `${local[0]}***@${domain[0]}***${domain.slice(domain.lastIndexOf("."))}`;

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Secure request from {org.name}</h1>
      <p className="mt-1 text-sm font-medium text-zinc-800">{request.title}</p>
      <p className="mt-3 text-sm text-zinc-600">
        To protect your information, we&apos;ll first verify it&apos;s really you.
        We&apos;ll send a one-time code to <strong>{masked}</strong>.
      </p>
      <div className="mt-4">
        <OtpVerify token={token} />
      </div>
      <p className="mt-4 text-xs text-zinc-500">
        Recruvault will never ask for this code by email, phone, or message. Your data
        is encrypted, access is audited, and it auto-deletes on the organisation&apos;s
        retention schedule.
      </p>
    </Shell>
  );
}
