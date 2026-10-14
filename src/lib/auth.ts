import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
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
import { recruiterSignupEnabled } from "@/lib/signup-policy";

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
      "/send-verification-email": { window: 60, max: 3 },
      "/request-password-reset": { window: 60, max: 3 },
      "/reset-password": { window: 60, max: 5 },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: u, url }) => {
      await sendAuthEmail({
        to: u.email,
        subject: "Reset your Recruvault password",
        heading: "Reset your password",
        body: "Use this secure link to choose a new password. It expires in one hour. If you did not request this, you can ignore this email.",
        ctaLabel: "Reset password",
        ctaUrl: url,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user: u, url }) => {
      await sendAuthEmail({
        to: u.email,
        subject: "Verify your email: Recruvault",
        heading: "Verify your email",
        body: "Confirm your email address to activate your Recruvault account.",
        ctaLabel: "Verify email",
        ctaUrl: url,
      });
    },
  },
  user: {
    additionalFields: {
      // Server-assigned only. Clients cannot set it on sign-up or update-user;
      // the user create hook below and first-owner setup are the only writers.
      accountType: {
        type: "string",
        defaultValue: "seeker",
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Recruiter self-registration is honoured only when the deployment
        // enables it; the hooks.before check below rejects it otherwise.
        before: async (u, ctx) => {
          const requested = (ctx?.body as { accountType?: unknown } | undefined)?.accountType;
          if (ctx?.path === "/sign-up/email" && requested === "org" && recruiterSignupEnabled()) {
            return { data: { ...u, accountType: "org" } };
          }
          return { data: { ...u, accountType: "seeker" } };
        },
      },
    },
    session: {
      create: {
        // Every sign-in path (password, magic link, passkey) creates a session
        // here. An erased account's tombstone can never get one.
        before: async (s) => {
          const [row] = await db
            .select({ erasedAt: user.erasedAt })
            .from(user)
            .where(eq(user.id, s.userId));
          if (row?.erasedAt) {
            throw APIError.from("FORBIDDEN", {
              code: "ACCOUNT_DELETED",
              message: "This account has been deleted.",
            });
          }
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (
        ctx.path === "/sign-up/email" &&
        ctx.body?.accountType === "org" &&
        !recruiterSignupEnabled()
      ) {
        throw APIError.from("FORBIDDEN", {
          code: "RECRUITER_SIGNUP_DISABLED",
          message: "Recruiter self-registration is closed.",
        });
      }
    }),
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
