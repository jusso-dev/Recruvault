import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import {
  user,
  session,
  account,
  verification,
  passkey as passkeyTable,
  rateLimit,
} from "@/db/schema";
import { sendAuthEmail } from "@/lib/email";

/**
 * BetterAuth serves both account worlds: organisation-side users (recruiters,
 * admins, reviewers, compliance) and job seekers. The `accountType` field
 * separates them; org membership and roles live in the memberships table and
 * are enforced in the data layer (lib/guards.ts).
 *
 * Job seekers sign in with email + password, magic link, or passkey.
 */
export const auth = betterAuth({
  baseURL: process.env.APP_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification, passkey: passkeyTable, rateLimit },
  }),
  // Database-backed so limits hold across app instances. Tight custom rules on
  // the credential and magic-link endpoints; a default cap on everything else.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 20,
    storage: "database",
    modelName: "rateLimit",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/magic-link/send": { window: 60, max: 3 },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user: u, url }) => {
      await sendAuthEmail({
        to: u.email,
        subject: "Verify your email — Recruvault",
        heading: "Verify your email",
        body: "Confirm your email address to activate your Recruvault account.",
        ctaLabel: "Verify email",
        ctaUrl: url,
      });
    },
  },
  user: {
    additionalFields: {
      accountType: {
        type: "string",
        defaultValue: "seeker",
        input: true,
      },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendAuthEmail({
          to: email,
          subject: "Your sign-in link — Recruvault",
          heading: "Sign in to Recruvault",
          body: "Use the button below to sign in. This link is single-use and expires shortly. Recruvault will never ask for your password by email.",
          ctaLabel: "Sign in",
          ctaUrl: url,
        });
      },
    }),
    passkey(),
    nextCookies(), // must be last
  ],
});

export type Session = typeof auth.$Infer.Session;
