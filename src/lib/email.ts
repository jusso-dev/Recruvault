import "server-only";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { suppressions } from "@/db/schema";
import { getLogger } from "@/lib/logger";

const log = getLogger("email");

/**
 * Transactional email via Resend.
 *
 * Email is part of the security surface: authenticated sending domains
 * (SPF/DKIM/DMARC), consistent branding, links only to the Recruvault domain,
 * and OTP emails state plainly that Recruvault will never ask for the code.
 * Every HTML email carries a plain-text alternative. Hard-bounced addresses
 * are suppressed (see suppressions table, populated by the Resend webhook).
 */

let resend: Resend | undefined;
function client() {
  resend ??= new Resend(process.env.RESEND_API_KEY);
  return resend;
}

export interface OrgSender {
  orgName: string;
  senderName?: string;
  sendingMode: "shared" | "custom_domain";
  sendingDomain?: string | null;
  // Date on the org row; a JSON-serialised ISO string when passed across an
  // Inngest step boundary. Only truthiness matters here.
  sendingDomainVerifiedAt?: Date | string | null;
}

/**
 * Sending identity per organisation: a verified custom domain when configured,
 * otherwise the shared Recruvault sending domain with the org's display name.
 */
export function fromAddress(org?: OrgSender): string {
  const shared = process.env.SHARED_SENDING_DOMAIN ?? "mail.recruvault.example";
  if (org?.sendingMode === "custom_domain" && org.sendingDomain && org.sendingDomainVerifiedAt) {
    return `${org.senderName ?? org.orgName} <no-reply@${org.sendingDomain}>`;
  }
  const display = org ? `${org.senderName ?? org.orgName} via Recruvault` : "Recruvault";
  const address =
    process.env.RESEND_FROM_EMAIL ??
    (process.env.NODE_ENV === "production" ? `no-reply@${shared}` : "onboarding@resend.dev");
  return `${display} <${address}>`;
}

async function isSuppressed(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, email.toLowerCase()));
  return !!row;
}

interface EmailContent {
  to: string;
  from?: string;
  subject: string;
  heading: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footerNote?: string;
  code?: string;
}

function renderHtml(c: EmailContent): string {
  // Plain, accessible, mobile-friendly: semantic HTML, strong contrast, minimal.
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#18181b;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e4e7;">
    <h1 style="font-size:20px;margin:0 0 16px;">${c.heading}</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px;">${c.body}</p>
    ${
      c.code
        ? `<p style="font-size:28px;letter-spacing:6px;font-weight:700;text-align:center;background:#f4f4f5;border-radius:8px;padding:16px;margin:0 0 20px;">${c.code}</p>`
        : ""
    }
    ${
      c.ctaLabel && c.ctaUrl
        ? `<p style="margin:0 0 20px;"><a href="${c.ctaUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">${c.ctaLabel}</a></p>`
        : ""
    }
    <p style="font-size:13px;color:#52525b;line-height:1.5;margin:20px 0 0;border-top:1px solid #e4e4e7;padding-top:16px;">
      ${c.footerNote ?? "Recruvault will never ask for your password or verification code by email. Links in Recruvault emails only ever point to your Recruvault domain."}
    </p>
  </div>
</body>
</html>`;
}

function renderText(c: EmailContent): string {
  return [
    c.heading,
    "",
    c.body,
    c.code ? `\nYour code: ${c.code}` : "",
    c.ctaLabel && c.ctaUrl ? `\n${c.ctaLabel}: ${c.ctaUrl}` : "",
    "",
    c.footerNote ??
      "Recruvault will never ask for your password or verification code by email.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function sendEmail(c: EmailContent): Promise<string | null> {
  if (await isSuppressed(c.to)) return null;
  if (!process.env.RESEND_API_KEY) {
    // Dev fallback: log instead of failing hard so local flows keep working.
    log.info(
      { to: c.to, subject: c.subject, code: c.code, url: c.ctaUrl },
      "email (dev fallback, not sent)",
    );
    return null;
  }
  const { data, error } = await client().emails.send({
    from: c.from ?? fromAddress(),
    to: c.to,
    subject: c.subject,
    html: renderHtml(c),
    text: renderText(c),
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  return data?.id ?? null;
}

/** Auth-flow emails (verification, magic link) — always from the shared identity. */
export async function sendAuthEmail(c: Omit<EmailContent, "from">) {
  return sendEmail(c);
}

export async function sendRequestInvite(opts: {
  to: string;
  org: OrgSender;
  requestTitle: string;
  link: string;
  expiresAt: Date | null;
}) {
  return sendEmail({
    to: opts.to,
    from: fromAddress(opts.org),
    subject: `${opts.org.orgName} has requested information securely — ${opts.requestTitle}`,
    heading: `${opts.org.orgName} sent you a secure request`,
    body: `${opts.org.orgName} is requesting information for <strong>${opts.requestTitle}</strong> through Recruvault, a secure vault — nothing sensitive travels by email. Open the secure link to see who is asking, why, and exactly what is requested before you share anything.${
      opts.expiresAt ? ` This link expires on ${opts.expiresAt.toDateString()}.` : ""
    }`,
    ctaLabel: "Open secure request",
    ctaUrl: opts.link,
  });
}

export async function sendOtpEmail(opts: { to: string; code: string; org: OrgSender }) {
  return sendEmail({
    to: opts.to,
    from: fromAddress(opts.org),
    subject: "Your Recruvault verification code",
    heading: "Your verification code",
    body: "Enter this code to open the secure request. It expires in 10 minutes.",
    code: opts.code,
    footerNote:
      "Recruvault will never ask you for this code by email, phone, or message. If you did not request it, ignore this email.",
  });
}

export async function sendSubmissionReceived(opts: {
  to: string;
  org: OrgSender;
  requestTitle: string;
  retentionDays: number;
}) {
  return sendEmail({
    to: opts.to,
    from: fromAddress(opts.org),
    subject: `Submission received — ${opts.requestTitle}`,
    heading: "Your submission was received",
    body: `Your response to <strong>${opts.requestTitle}</strong> from ${opts.org.orgName} was submitted securely. It is encrypted, access is audited, and it will be automatically deleted ${opts.retentionDays} days after submission. You can request earlier deletion at any time from your Recruvault account or by contacting the organisation.`,
  });
}

export async function sendRecruiterSubmissionAlert(opts: {
  to: string;
  requestTitle: string;
  reviewUrl: string;
}) {
  return sendEmail({
    to: opts.to,
    subject: `New submission — ${opts.requestTitle}`,
    heading: "A new submission arrived",
    body: `A candidate has responded to <strong>${opts.requestTitle}</strong>. Review it securely in Recruvault.`,
    ctaLabel: "Review submission",
    ctaUrl: opts.reviewUrl,
  });
}

function safeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function sendJobMatchAlert(opts: {
  to: string;
  org: OrgSender;
  requestTitle: string;
  location: string | null;
  matchScore: number;
  matchedSkills: string[];
  rolesUrl: string;
}) {
  const skillText = opts.matchedSkills.map(safeText).join(", ");
  const locationText = opts.location ? ` in ${safeText(opts.location)}` : "";
  return sendEmail({
    to: opts.to,
    from: fromAddress(opts.org),
    subject: `New role matching your job alerts — ${opts.requestTitle}`,
    heading: "A role matches your job alerts",
    body: `<strong>${safeText(opts.requestTitle)}</strong> from ${safeText(opts.org.orgName)}${locationText} matched ${opts.matchScore}% of the role skills in your alert preferences.${
      skillText ? ` Matching skills: ${skillText}.` : ""
    } Recruvault has not shared your identity, profile, or documents with the recruiter. Review the listing before deciding whether to proceed.`,
    ctaLabel: "Review matching role",
    ctaUrl: opts.rolesUrl,
    footerNote:
      "You received this because you opted in to Recruvault job alerts. Sign in and open Applications to change or stop your alerts at any time.",
  });
}

export async function sendExpiryReminder(opts: {
  to: string;
  org: OrgSender;
  requestTitle: string;
  link: string;
  expiresAt: Date;
}) {
  return sendEmail({
    to: opts.to,
    from: fromAddress(opts.org),
    subject: `Reminder: secure request expiring — ${opts.requestTitle}`,
    heading: "This secure request expires soon",
    body: `The secure request for <strong>${opts.requestTitle}</strong> from ${opts.org.orgName} expires on ${opts.expiresAt.toDateString()}. After that the link stops working.`,
    ctaLabel: "Open secure request",
    ctaUrl: opts.link,
  });
}

export async function sendErasureConfirmation(opts: { to: string }) {
  return sendEmail({
    to: opts.to,
    subject: "Your data has been deleted — Recruvault",
    heading: "Deletion confirmed",
    body: "Your requested data has been deleted from Recruvault using cryptographic shredding — the encryption keys were destroyed, making the data unrecoverable. A metadata-only audit record of the deletion is retained.",
  });
}
