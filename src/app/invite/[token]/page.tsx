import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { acceptInvitation } from "@/actions/invitations";
import { ActionForm } from "@/components/action-form";
import { SignOutButton } from "@/components/sign-out";
import { Button, ButtonLink, Card, CardContent } from "@/components/ui";
import { VerifyEmailPanel } from "@/components/verify-email-panel";
import { getSession, requestMeta } from "@/lib/guards";
import {
  candidateRecordFor,
  findInvitationByToken,
  invitationState,
  maskEmail,
} from "@/lib/invitations";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-stone-50 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-3 p-6">{children}</CardContent>
      </Card>
    </main>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Shell>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm leading-6 text-stone-600">{children}</p>
    </Shell>
  );
}

/**
 * Teammate invitation entry point. The token is single-use and only its hash
 * is stored. Acceptance is a separate POST, so opening the link never changes
 * an account.
 */
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const meta = await requestMeta();
  if (!(await checkRateLimit(`invite:view:${meta.ip ?? "unknown"}`, 30, 60_000))) {
    return <Notice title="Too many attempts">Wait a minute, then open the invitation again.</Notice>;
  }

  const found = await findInvitationByToken(token);
  if (!found) {
    return (
      <Notice title="This invitation is not valid">
        Check you copied the full link, or ask the organisation to send a new invitation.
      </Notice>
    );
  }
  const { invitation, orgName } = found;
  const state = invitationState(invitation);
  if (state === "accepted") {
    return <Notice title="Invitation already used">This invitation has been accepted. Sign in to continue.</Notice>;
  }
  if (state === "revoked") {
    return <Notice title="Invitation withdrawn">{orgName} withdrew this invitation. Ask them for a new one.</Notice>;
  }
  if (state === "expired") {
    return <Notice title="Invitation expired">Invitations expire after 7 days. Ask {orgName} to send a new one.</Notice>;
  }

  const here = `/invite/${token}`;
  const session = await getSession();
  const heading = (
    <>
      <p className="text-sm font-medium text-accent">Team invitation</p>
      <h1 className="text-xl font-semibold">Join {orgName}</h1>
      <p className="text-sm leading-6 text-stone-600">
        You have been invited to join as <strong className="font-semibold text-stone-800">{invitation.role}</strong>.
        The invitation is for <strong className="font-semibold text-stone-800">{maskEmail(invitation.email)}</strong>{" "}
        and expires on {invitation.expiresAt.toLocaleDateString("en-AU")}.
      </p>
    </>
  );

  if (!session) {
    return (
      <Shell>
        {heading}
        <p className="text-sm leading-6 text-stone-600">
          Sign in or create an account with the invited email address to accept.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <ButtonLink href={`/sign-in?next=${encodeURIComponent(here)}`}>Sign in</ButtonLink>
          <ButtonLink href={`/sign-up?next=${encodeURIComponent(here)}`} variant="secondary">
            Create an account
          </ButtonLink>
        </div>
      </Shell>
    );
  }

  if (session.user.email.toLowerCase() !== invitation.email) {
    return (
      <Shell>
        {heading}
        <p role="alert" className="text-sm leading-6 text-red-800">
          You are signed in as {session.user.email}, which is not the invited address. Sign out,
          then open this link again and sign in with the invited address.
        </p>
        <SignOutButton />
      </Shell>
    );
  }

  if (!(session.user as { emailVerified?: boolean }).emailVerified) {
    return (
      <main className="flex min-h-screen flex-1 items-center justify-center bg-stone-50 p-4">
        <VerifyEmailPanel email={session.user.email} next={here} />
      </main>
    );
  }

  const [membership] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.userId, session.user.id));
  if (membership) {
    return (
      <Notice title="Already in an organisation">
        This account already belongs to an organisation. Each account can belong to one
        organisation. Ask {orgName} to invite a different email address.
      </Notice>
    );
  }
  if ((await candidateRecordFor(db, session.user.id)).hasData) {
    return (
      <Notice title="This account holds a career record">
        This account is a job seeker account with applications, documents, or an encryption
        key, so it cannot join an organisation. Ask {orgName} to invite a different email
        address.
      </Notice>
    );
  }

  return (
    <Shell>
      {heading}
      <p className="text-sm leading-6 text-stone-600">
        After you accept, enter the organisation encryption key to open records. Get it from
        the organisation owner through a trusted channel. Recruvault never sends it by email.
      </p>
      <ActionForm action={acceptInvitation} redirectTo="/dashboard" className="space-y-3">
        <input type="hidden" name="token" value={token} />
        <Button type="submit" className="w-full">
          Accept and join {orgName}
        </Button>
      </ActionForm>
    </Shell>
  );
}
