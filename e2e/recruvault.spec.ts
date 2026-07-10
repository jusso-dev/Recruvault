import { mkdir } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  requestIdForTitle,
  setUserEmailVerified,
  submissionIdForRequest,
} from "./db-helpers";
import { waitForEmail } from "./email-helpers";

test.describe.configure({ mode: "serial" });

const AUTH_DIR = ".playwright/auth";
const SCREENSHOT_DIR = "docs/screenshots";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const OWNER_STATE = `${AUTH_DIR}/owner.json`;
const REVIEWER_STATE = `${AUTH_DIR}/reviewer.json`;
const SEEKER_STATE = `${AUTH_DIR}/seeker.json`;

const accounts = {
  bootstrap: {
    name: "Bailey Stone",
    email: "bootstrap@e2e.recruvault.test",
    password: "E2eSecure!123",
  },
  owner: {
    name: "Olivia Hart",
    email: "owner@e2e.recruvault.test",
    password: "E2eSecure!123",
  },
  reviewer: {
    name: "Ravi Singh",
    email: "reviewer@e2e.recruvault.test",
    password: "E2eSecure!123",
  },
  seeker: {
    name: "Jordan Lee",
    email: "seeker@e2e.recruvault.test",
    password: "E2eSecure!123",
  },
  recovery: {
    name: "Morgan Chen",
    email: "recovery@e2e.recruvault.test",
    password: "E2eSecure!123",
  },
};

const organisationName = "Acacia Talent Partners";
const roleTitle = "Senior Systems Engineer, NV1";

let requestId = "";
let invitationUrl = "";
let submissionId = "";

const pdfFile = (name: string) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"),
});

async function capture(page: Page, fileName: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${fileName}`, fullPage: true });
}

function toast(page: Page) {
  return page.getByRole("button", { name: "Dismiss notification" }).locator("..");
}

async function signUp(
  page: Page,
  account: (typeof accounts)[keyof typeof accounts],
  type: "org" | "seeker",
) {
  await page.goto(`/sign-up?type=${type}`);
  await page.getByLabel("Full name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  const sentAfter = Date.now();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(account.email, { exact: true })).toBeVisible();
  if (type === "org") {
    const resentAfter = Date.now();
    await page.getByRole("button", { name: "Resend verification email" }).click();
    await expect(toast(page)).toContainText("Verification email sent");
    const email = await waitForEmail({
      to: account.email,
      subject: "Verify your email: Recruvault",
      after: resentAfter,
    });
    expect(email.ctaUrl).toBeTruthy();
    await page.context().clearCookies();
    await page.goto(email.ctaUrl!);
  } else {
    const email = await waitForEmail({
      to: account.email,
      subject: "Verify your email: Recruvault",
      after: sentAfter,
    });
    expect(email.ctaUrl).toBeTruthy();
    await page.context().clearCookies();
    await page.goto(email.ctaUrl!);
  }
  await page.waitForURL(type === "org" ? "**/onboarding" : "**/overview");
}

async function newAuthenticatedPage(browser: Browser, storageState: string) {
  const context = await browser.newContext({ storageState, baseURL: BASE_URL });
  const page = await context.newPage();
  return { context, page };
}

test.beforeAll(async () => {
  await mkdir(AUTH_DIR, { recursive: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
});

test("creates recruiter, reviewer, and job-seeker accounts through the UI", async ({
  browser,
  page,
}) => {
  await test.step("enforce the first-install recruiter setup boundary", async () => {
    await page.goto("/setup");

    if (new URL(page.url()).pathname === "/setup") {
      await expect(
        page.getByRole("heading", { name: "Set up your recruiter workspace" }),
      ).toBeVisible();
      await page.getByLabel("First name").fill("Bailey");
      await page.getByLabel("Last name").fill("Stone");
      await page.getByLabel("Work email").fill(accounts.bootstrap.email);
      await page.getByLabel("Organisation name").fill("E2E Platform Bootstrap");
      await page.getByLabel("Password", { exact: true }).fill(accounts.bootstrap.password);
      await page.getByLabel("Confirm password").fill("does-not-match");
      await page.getByRole("button", { name: "Create owner and organisation" }).click();
      await expect(toast(page)).toContainText("passwords do not match");
      await page.getByLabel("Confirm password").fill(accounts.bootstrap.password);
      await page.getByRole("button", { name: "Create owner and organisation" }).click();
      await page.waitForURL("**/dashboard");
      await expect(page.getByText("E2E Platform Bootstrap")).toBeVisible();
      await page.getByRole("button", { name: "Sign out" }).click();
    }

    await page.goto("/setup");
    await page.waitForURL("**/sign-in");
  });

  await test.step("capture public and friendly error states", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "From application to placement." })).toBeVisible();
    await capture(page, "01-landing.png");

    await page.goto("/sign-in");
    await capture(page, "02-sign-in.png");
    await page.getByLabel("Email").fill("missing@e2e.recruvault.test");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(toast(page)).toContainText("Check your email and password");
    await capture(page, "03-friendly-error-toast.png");
    await page.getByRole("button", { name: "Dismiss notification" }).click();

    await page.goto("/sign-up?type=seeker");
    await capture(page, "04-sign-up.png");

    await page.goto("/setup");
    await page.waitForURL("**/sign-in");
  });

  await test.step("reset a forgotten password through the emailed-link flow", async () => {
    const recoveryContext = await browser.newContext({ baseURL: BASE_URL });
    const recoveryPage = await recoveryContext.newPage();
    await signUp(recoveryPage, accounts.recovery, "seeker");
    await recoveryContext.close();

    const resetContext = await browser.newContext({ baseURL: BASE_URL });
    const resetPage = await resetContext.newPage();
    await resetPage.goto("/sign-in");
    await resetPage.getByRole("link", { name: "Forgot password?" }).click();
    await resetPage.waitForURL("**/forgot-password");
    await resetPage.getByLabel("Email").fill(accounts.recovery.email);
    const resetSentAfter = Date.now();
    await resetPage.getByRole("button", { name: "Send reset link" }).click();
    await expect(resetPage.getByRole("heading", { name: "Check your email" })).toBeVisible();

    const resetEmail = await waitForEmail({
      to: accounts.recovery.email,
      subject: "Reset your Recruvault password",
      after: resetSentAfter,
    });
    expect(resetEmail.ctaUrl).toBeTruthy();
    await resetPage.goto(resetEmail.ctaUrl!);
    await resetPage.waitForURL("**/reset-password?token=*");
    await resetPage.getByLabel("New password", { exact: true }).fill("UpdatedSecure!456");
    await resetPage.getByLabel("Confirm new password").fill("UpdatedSecure!456");
    await resetPage.getByRole("button", { name: "Update password" }).click();
    await expect(resetPage.getByRole("heading", { name: "Password updated" })).toBeVisible();

    await resetPage.getByRole("link", { name: "Back to sign in" }).click();
    await resetPage.getByLabel("Email").fill(accounts.recovery.email);
    await resetPage.getByLabel("Password").fill("UpdatedSecure!456");
    await resetPage.getByRole("button", { name: "Sign in" }).click();
    await expect(
      resetPage.getByRole("heading", { name: "Your application dashboard" }),
    ).toBeVisible();
    await resetContext.close();
  });

  await test.step("create the organisation owner and workspace", async () => {
    await signUp(page, accounts.owner, "org");
    await page.getByLabel("Organisation name").fill(organisationName);
    await page.getByRole("button", { name: "Create organisation" }).click();
    await page.waitForURL("**/dashboard");
    await expect(page.getByRole("heading", { name: "Placement dashboard" })).toBeVisible();
    await page.context().storageState({ path: OWNER_STATE });
    await capture(page, "05-recruiter-dashboard-empty.png");
  });

  await test.step("create reviewer and job-seeker accounts", async () => {
    const reviewerContext = await browser.newContext({ baseURL: BASE_URL });
    const reviewerPage = await reviewerContext.newPage();
    await signUp(reviewerPage, accounts.reviewer, "org");
    await reviewerContext.storageState({ path: REVIEWER_STATE });
    await reviewerContext.close();

    const seekerContext = await browser.newContext({ baseURL: BASE_URL });
    const seekerPage = await seekerContext.newPage();
    await signUp(seekerPage, accounts.seeker, "seeker");
    await expect(seekerPage.getByRole("heading", { name: "Your application dashboard" })).toBeVisible();
    await seekerContext.storageState({ path: SEEKER_STATE });
    await capture(seekerPage, "06-job-seeker-overview-empty.png");
    await seekerContext.close();
  });

  await test.step("add the reviewer through organisation settings", async () => {
    await page.goto("/dashboard/settings");
    await page.getByLabel("Add member by email").fill(accounts.reviewer.email);
    await page.getByLabel("Role", { exact: true }).selectOption("reviewer");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(toast(page)).toContainText("Member added");
    await capture(page, "07-organisation-settings.png");
  });
});

test("creates a role and enforces recruiter-only permissions", async ({ browser }) => {
  const { context, page } = await newAuthenticatedPage(browser, OWNER_STATE);

  await test.step("create a role with the four supported requirements", async () => {
    await page.goto("/dashboard/requests/new");
    await expect(page.getByText("Citizenship", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Resume / CV")).toBeChecked();
    await expect(page.getByLabel("Cover letter / suitability statement")).toBeChecked();
    await capture(page, "08-new-role.png");

    await page.getByLabel("Title").fill(roleTitle);
    await page
      .getByLabel("Description (shown to the candidate)")
      .fill("Lead secure systems delivery for a major Australian government program.");
    await page.getByLabel("Skills and keywords").fill("Azure, TypeScript, systems engineering");
    await page.getByLabel("Location").fill("Canberra, ACT");
    await page.getByLabel("Employment type").selectOption("contract");
    await page.getByLabel("Work arrangement").selectOption("hybrid");
    await page.getByLabel("Salary or rate period").selectOption("daily");
    await page.getByLabel("Minimum salary or rate").fill("1500");
    await page.getByLabel("Maximum salary or rate").fill("1200");
    await page.getByLabel("Security clearance level").check();
    await page.getByLabel("Security clearance ID").check();
    await page.getByLabel("Link expiry").fill("2027-12-31");
    await page.getByLabel(/List this role/).check();
    await page.getByLabel(/Save as a template/).check();
    await page.getByRole("button", { name: "Create role" }).click();
    await expect(toast(page)).toContainText("minimum salary or rate cannot exceed");
    await page.getByLabel("Minimum salary or rate").fill("1200");
    await page.getByLabel("Maximum salary or rate").fill("1400");
    await page.getByRole("button", { name: "Create role" }).click();
    await page.waitForURL(/\/dashboard\/requests\/[0-9a-f-]+$/);
    requestId = await requestIdForTitle(roleTitle);
    await expect(page.getByText("Security clearance ID", { exact: true })).toBeVisible();
    await expect(page.getByText("Cover letter / suitability statement", { exact: true })).toBeVisible();
    await capture(page, "09-role-detail.png");

    await page.goto("/dashboard/job-alerts");
    await page.getByLabel("Send automated matched-role emails").check();
    await page.getByLabel("Minimum role-skill match").selectOption("50");
    await page.getByRole("button", { name: "Save alert settings" }).click();
    await expect(toast(page)).toContainText("Matched role alert settings saved");
    await capture(page, "09b-recruiter-matched-alerts.png");

    await page.goto("/dashboard/requests/new");
    const template = page.getByText(roleTitle, { exact: true });
    await expect(template).toBeVisible();
    await template.click();
    await expect(page.getByLabel("Title")).toHaveValue(roleTitle);
    await page.getByRole("button", { name: `Delete template ${roleTitle}` }).click();
    await expect(toast(page)).toContainText("Template deleted");

    await page.goto(`/dashboard/requests/${requestId}`);
    await page.getByLabel("Candidate email").fill("not-an-email");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByLabel("Candidate email")).not.toBeEmpty();
    expect(
      await page.getByLabel("Candidate email").evaluate((element: HTMLInputElement) =>
        element.checkValidity(),
      ),
    ).toBe(false);

    await page.getByLabel("Candidate email").fill(accounts.seeker.email);
    const inviteSentAfter = Date.now();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(toast(page)).toContainText("secure link is on its way");
    const invitation = await waitForEmail({
      to: accounts.seeker.email,
      subject: `${organisationName} has requested information securely — ${roleTitle}`,
      after: inviteSentAfter,
    });
    expect(invitation.ctaUrl).toBeTruthy();
    invitationUrl = invitation.ctaUrl!;
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(accounts.seeker.email)).toBeVisible();
      await expect(
        page.getByRole("listitem").filter({ hasText: accounts.seeker.email }).getByText("sent"),
      ).toBeVisible();
    }).toPass();

    const revokedEmail = "revoked@e2e.recruvault.test";
    await page.getByLabel("Candidate email").fill(revokedEmail);
    const revokedSentAfter = Date.now();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const revokedInvitation = await waitForEmail({
      to: revokedEmail,
      subject: `${organisationName} has requested information securely — ${roleTitle}`,
      after: revokedSentAfter,
    });
    await page.reload();
    const revokedDelivery = page.getByRole("listitem").filter({ hasText: revokedEmail });
    await revokedDelivery.getByRole("button", { name: "Revoke" }).click();
    await expect(toast(page)).toContainText("Secure link revoked");
    const revokedContext = await browser.newContext({ baseURL: BASE_URL });
    const revokedPage = await revokedContext.newPage();
    await revokedPage.goto(revokedInvitation.ctaUrl!);
    await expect(revokedPage.getByText(/revoked/i)).toBeVisible();
    await revokedContext.close();
  });

  await test.step("prevent a reviewer from creating or administering roles", async () => {
    await setUserEmailVerified(accounts.reviewer.email, false);
    const reviewer = await newAuthenticatedPage(browser, REVIEWER_STATE);
    await reviewer.page.goto("/dashboard");
    await expect(
      reviewer.page.getByRole("heading", { name: "Verify your email" }),
    ).toBeVisible();
    await expect(
      reviewer.page.getByRole("button", { name: "Resend verification email" }),
    ).toBeVisible();
    await expect(reviewer.page.getByText(accounts.reviewer.email)).toBeVisible();
    await setUserEmailVerified(accounts.reviewer.email, true);

    await reviewer.page.goto("/dashboard/requests/new");
    await expect(reviewer.page.getByRole("heading", { name: "You can't view this" })).toBeVisible();
    await expect(reviewer.page.getByRole("link", { name: "New role" })).toHaveCount(0);
    await capture(reviewer.page, "10-permission-denied.png");

    for (const protectedRoute of [
      "/dashboard/settings",
      "/dashboard/integrations",
      "/dashboard/job-alerts",
      "/dashboard/audit",
    ]) {
      await reviewer.page.goto(protectedRoute);
      await expect(
        reviewer.page.getByRole("heading", { name: "You can't view this" }),
      ).toBeVisible();
    }
    await reviewer.context.close();
  });

  await context.close();
});

test("job seeker manages documents, profile, saved roles, and an application", async ({
  browser,
}) => {
  const { context, page } = await newAuthenticatedPage(browser, SEEKER_STATE);

  await test.step("create and delete reusable career documents", async () => {
    await page.goto("/documents");
    await expect(page.getByText("Identity and supporting evidence", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Document type").locator("option")).toHaveText([
      "Resume / CV",
      "Cover letter / suitability statement",
    ]);
    await page.getByLabel("Document type").selectOption("resume");
    await page.getByLabel(/PDF, Word, or image/).setInputFiles({
      name: "not-a-resume.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("This is not a supported career document."),
    });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(toast(page)).toContainText("Use a PDF or Word document");
    await page.getByLabel(/PDF, Word, or image/).setInputFiles(pdfFile("Jordan-Lee-Resume.pdf"));
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(toast(page)).toContainText("Uploaded");
    await expect(page.getByText("Jordan-Lee-Resume.pdf")).toBeVisible();
    await expect(async () => {
      await page.reload();
      await expect(
        page
          .getByRole("listitem")
          .filter({ hasText: "Jordan-Lee-Resume.pdf" })
          .getByText("clean"),
      ).toBeVisible();
    }).toPass();

    await page.getByLabel("Document type").selectOption("cover_letter");
    await page.getByLabel(/PDF, Word, or image/).setInputFiles(pdfFile("Acacia-Cover-Letter.pdf"));
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(toast(page)).toContainText("Uploaded");
    await expect(page.getByText("Acacia-Cover-Letter.pdf")).toBeVisible();
    await capture(page, "11-career-documents.png");

    const coverLetter = page.getByRole("listitem").filter({ hasText: "Acacia-Cover-Letter.pdf" });
    await coverLetter.getByRole("button", { name: "Delete" }).click();
    await expect(toast(page)).toContainText("Document deleted");
    await expect(page.getByText("Acacia-Cover-Letter.pdf")).toHaveCount(0);
  });

  await test.step("update reusable credentials and recruiter discovery", async () => {
    await page.goto("/wallet");
    await expect(page.getByLabel("Citizenship")).toHaveCount(0);
    await expect(page.getByLabel("Right to work")).toHaveCount(0);
    await page.getByLabel("Credential").selectOption("clearance_id");
    await page.getByLabel("Value").fill("AGSVA-CL-2048");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toContainText("Credential saved");

    await page.getByLabel("Credential").selectOption("clearance_level");
    await page.getByLabel("Value").fill("NV1");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toContainText("Credential saved");
    const clearanceLevel = page.getByRole("listitem").filter({
      hasText: "Security clearance level",
    });
    await clearanceLevel.getByRole("button", { name: "Delete" }).click();
    await expect(toast(page)).toContainText("Credential deleted");
    await expect(clearanceLevel).toHaveCount(0);

    await page.getByRole("button", { name: "Save discovery profile" }).click();
    await expect(toast(page)).toContainText("Discovery updated");

    await page.getByLabel("Discoverable by recruiters").check();
    await page.getByLabel("Clearance level").selectOption("nv1");
    await page.getByLabel("General location").fill("Canberra, ACT");
    await page.getByLabel(/Skills/).fill("systems engineering, AWS, ISM");
    await page.getByRole("button", { name: "Save discovery profile" }).click();
    await expect(toast(page)).toContainText("Discovery updated");
    await capture(page, "12-profile-and-credentials.png");
  });

  await test.step("save an invited role", async () => {
    await page.goto("/roles");
    await expect(page.getByText(roleTitle, { exact: true })).toBeVisible();
    await page.getByLabel("Email me when a listed role matches").check();
    await page.getByLabel("Skills and interests").fill("Azure, TypeScript");
    const alertSentAfter = Date.now();
    await page.getByRole("button", { name: "Save alert preferences" }).click();
    await expect(toast(page)).toContainText("Job alert preferences saved");
    const matchEmail = await waitForEmail({
      to: accounts.seeker.email,
      subject: `New role matching your job alerts — ${roleTitle}`,
      after: alertSentAfter,
    });
    expect(matchEmail.ctaUrl).toContain("/roles");
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/alert match/)).toBeVisible();
    }).toPass();
    await expect(page.getByLabel("Keyword")).toBeVisible();
    await expect(page.getByLabel("Location", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Minimum salary/rate")).toBeVisible();
    await page.getByRole("button", { name: "Save role" }).click();
    await expect(toast(page)).toContainText("Role saved");
    await page.getByRole("button", { name: "Saved" }).click();
    await expect(toast(page)).toContainText("removed from saved roles");
    await page.getByRole("button", { name: "Save role" }).click();
    await expect(toast(page)).toContainText("Role saved");
    await page.getByLabel("Keyword").fill("systems");
    await page.getByLabel("Location", { exact: true }).selectOption("Canberra, ACT");
    await page.getByLabel("Employment").selectOption("contract");
    await page.getByLabel("Minimum salary/rate").fill("1300");
    await page.getByLabel("Sort by").selectOption("salary");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByText("1 result", { exact: true })).toBeVisible();
    await expect(page.getByText("$1,200–$1,400 per day", { exact: true })).toBeVisible();
    await capture(page, "13-applications-and-roles.png");
  });

  await test.step("complete OTP and submit the application", async () => {
    await page.goto(invitationUrl);
    await expect(page.getByRole("heading", { name: new RegExp(organisationName) })).toBeVisible();
    await capture(page, "14-secure-invitation.png");
    const otpSentAfter = Date.now();
    await page.getByRole("button", { name: "Send me the code" }).click();
    await expect(toast(page)).toContainText("Code sent");
    const otpEmail = await waitForEmail({
      to: accounts.seeker.email,
      subject: "Your Recruvault verification code",
      after: otpSentAfter,
    });
    expect(otpEmail.code).toMatch(/^\d{6}$/);
    await page.getByLabel("Enter the 6-digit code").fill("000000");
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await expect(toast(page)).toContainText(/code/i);
    await page.getByLabel("Enter the 6-digit code").fill(otpEmail.code!);
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL("**/r/*/respond");
    await expect(page.getByRole("heading", { name: roleTitle })).toBeVisible();
    await capture(page, "15-application-form.png");

    await page.getByLabel(/Security clearance level/).selectOption("nv1");
    await page.getByLabel(/Security clearance ID/).fill("AGSVA-CL-2048");
    await page.getByRole("button", { name: "Save and finish later" }).click();
    await expect(toast(page)).toContainText("Draft saved");
    await page.reload();
    await expect(page.getByLabel(/Security clearance level/)).toHaveValue("nv1");
    await expect(page.getByLabel(/Security clearance ID/)).toHaveValue("AGSVA-CL-2048");
    await page.getByLabel(/Resume \/ CV/).setInputFiles(pdfFile("Jordan-Lee-Resume.pdf"));
    await page
      .getByLabel(/Cover letter \/ suitability statement/)
      .setInputFiles(pdfFile("Acacia-Suitability-Statement.pdf"));
    await page.getByLabel(/I consent to/).check();
    await page.getByRole("button", { name: "Submit securely" }).click();
    await page.waitForURL("**/r/*/done");
    await expect(page.getByRole("heading", { name: "Submitted securely" })).toBeVisible();
    await capture(page, "16-application-submitted.png");
    submissionId = await submissionIdForRequest(requestId);
    const consumedContext = await browser.newContext({ baseURL: BASE_URL });
    const consumedPage = await consumedContext.newPage();
    await consumedPage.goto(invitationUrl);
    await expect(consumedPage.getByRole("heading", { name: "Already completed" })).toBeVisible();
    await consumedContext.close();
  });

  await test.step("show the submitted application in the seeker workspace", async () => {
    await page.goto("/overview");
    await expect(page.getByText(roleTitle, { exact: true })).toBeVisible();
    await capture(page, "17-job-seeker-overview.png");
    await page.goto("/roles");
    await expect(page.getByText("Application received", { exact: true }).first()).toBeVisible();
    await capture(page, "18-applications-tracker.png");
  });

  await test.step("use a job-seeker API key and keep recruiter data inaccessible", async () => {
    await page.goto("/integrations");
    await expect(page.getByRole("heading", { name: "API & MCP" })).toBeVisible();
    await expect(page.getByText(/Job-seeker tools: list_applications/)).toBeVisible();
    await expect(page.getByLabel("Agent setup prompt")).toContainText(
      "Account type: job seeker",
    );
    await page.getByRole("button", { name: "Copy agent prompt" }).click();
    await expect(toast(page)).toContainText("agent setup prompt has been copied");
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    await page.getByLabel("New key name").fill("E2E job-seeker MCP");
    await page.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByText("Copy your key now")).toBeVisible();
    const key = await page.locator("code").filter({ hasText: /^rv_(?!your_key)/ }).first().innerText();

    const applications = await page.request.get("/api/v1/me/applications", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(applications.ok()).toBe(true);
    expect((await applications.json()).applications).toHaveLength(1);

    const profileUpdate = await page.request.patch("/api/v1/me/profile", {
      headers: { Authorization: `Bearer ${key}` },
      data: {
        discoverable: true,
        clearanceLevel: "nv1",
        skills: ["systems engineering", "AWS", "ISM"],
        location: "Canberra, ACT",
      },
    });
    expect(profileUpdate.ok()).toBe(true);

    const recruiterData = await page.request.get("/api/v1/requests", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(recruiterData.status()).toBe(401);
    await page
      .locator("code")
      .filter({ hasText: /^rv_(?!your_key)/ })
      .first()
      .evaluate((element) => {
        element.textContent = "rv_example_key_hidden_after_creation";
      });
    await capture(page, "26-job-seeker-api-mcp.png");

    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(toast(page)).toContainText("API key revoked");
    const revoked = await page.request.get("/api/v1/me/applications", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(revoked.status()).toBe(401);
  });

  await context.close();
});

test("recruiter progresses and shares an application while reviewer stays read-only", async ({
  browser,
}) => {
  const owner = await newAuthenticatedPage(browser, OWNER_STATE);

  await test.step("progress the candidate through every placement stage", async () => {
    await owner.page.goto(`/dashboard/requests/${requestId}/submissions/${submissionId}`);
    await expect(owner.page.getByRole("heading", { name: `Submission: ${roleTitle}` })).toBeVisible();
    await capture(owner.page, "19-candidate-review.png");

    for (const [value, label] of [
      ["under_review", "Under review"],
      ["follow_up", "More information needed"],
      ["received", "Application received"],
      ["shortlisted", "Shortlisted"],
      ["interview", "Interview"],
      ["offer", "Offer"],
      ["accepted", "Offer accepted"],
      ["declined", "Not progressing"],
      ["withdrawn", "Withdrawn"],
      ["placed", "Placed"],
    ] as const) {
      await owner.page.getByLabel("Set status").selectOption(value);
      await owner.page.getByRole("button", { name: "Update" }).click();
      await expect(toast(owner.page)).toContainText("Application stage updated");
      await expect(owner.page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    await owner.page
      .getByLabel("Share with reviewer")
      .selectOption({ label: `${accounts.reviewer.name} (${accounts.reviewer.email})` });
    await owner.page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(toast(owner.page)).toContainText("shared with the reviewer");
    await owner.page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(toast(owner.page)).toContainText("shared with the reviewer");
    await capture(owner.page, "20-placed-candidate.png");
  });

  await test.step("show placement on dashboard and audit trail", async () => {
    await owner.page.goto("/dashboard");
    await expect(owner.page.getByText("Placements", { exact: true })).toBeVisible();
    await capture(owner.page, "21-recruiter-dashboard.png");
    await owner.page.goto("/dashboard/audit");
    await expect(owner.page.getByRole("heading", { name: "Audit trail" })).toBeVisible();
    await capture(owner.page, "22-audit-trail.png");
  });

  await test.step("allow shared read-only access and block reviewer administration", async () => {
    const reviewer = await newAuthenticatedPage(browser, REVIEWER_STATE);
    await reviewer.page.goto(`/dashboard/requests/${requestId}/submissions/${submissionId}`);
    await expect(reviewer.page.getByText("AGSVA-CL-2048", { exact: true })).toBeVisible();
    await expect(reviewer.page.getByLabel("Set status")).toHaveCount(0);
    await capture(reviewer.page, "23-reviewer-read-only.png");

    await reviewer.page.goto("/dashboard/settings");
    await expect(reviewer.page.getByRole("heading", { name: "You can't view this" })).toBeVisible();
    await reviewer.page.goto(`/dashboard/requests/${requestId}`);
    await expect(reviewer.page).toHaveURL(new RegExp(`/dashboard/requests/${requestId}$`));
    await expect(reviewer.page.getByLabel("Candidate email")).toHaveCount(0);
    await reviewer.context.close();
  });

  await test.step("exercise role, API key, and member update/delete controls", async () => {
    await owner.page.goto(`/dashboard/requests/${requestId}`);
    for (const status of ["closing_soon", "closed", "archived", "open"] as const) {
      await owner.page.getByLabel("Status").selectOption(status);
      await owner.page.getByRole("button", { name: "Update" }).click();
      await expect(toast(owner.page)).toContainText("Role status updated");
      await expect(owner.page.getByLabel("Status")).toHaveValue(status);
    }

    await owner.page.goto("/dashboard/integrations");
    await expect(owner.page.getByLabel("Agent setup prompt")).toContainText(
      "Account type: recruiter",
    );
    await expect(
      owner.page.getByRole("button", { name: "Copy agent prompt" }),
    ).toBeVisible();
    await owner.page.getByLabel("New key name").fill("E2E automation");
    await owner.page.getByRole("button", { name: "Create key" }).click();
    await expect(owner.page.getByText("Copy your key now")).toBeVisible();
    const key = await owner.page
      .locator("code")
      .filter({ hasText: /^rv_(?!your_key)/ })
      .first()
      .innerText();
    const requestsResponse = await owner.page.request.get("/api/v1/requests", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(requestsResponse.ok()).toBe(true);
    expect((await requestsResponse.json()).requests).toHaveLength(1);
    const reportResponse = await owner.page.request.get("/api/v1/reports/recruiter", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(reportResponse.ok()).toBe(true);
    const report = await reportResponse.json();
    expect(report.summary.totalApplications).toBe(1);
    expect(report.rolePipeline).toHaveLength(1);
    await expect(owner.page.getByText("Useful prompts", { exact: true })).toBeVisible();
    await expect(
      owner.page.getByText(/main priorities for this week/i),
    ).toBeVisible();
    const candidateData = await owner.page.request.get("/api/v1/me/applications", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(candidateData.status()).toBe(401);
    await owner.page
      .locator("code")
      .filter({ hasText: /^rv_(?!your_key)/ })
      .first()
      .evaluate((element) => {
        element.textContent = "rv_example_key_hidden_after_creation";
      });
    await capture(owner.page, "27-recruiter-api-mcp.png");
    await owner.page.getByRole("button", { name: "Revoke" }).click();
    await expect(toast(owner.page)).toContainText("API key revoked");
    const revoked = await owner.page.request.get("/api/v1/requests", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(revoked.status()).toBe(401);

    await owner.page.goto("/dashboard/settings");
    await owner.page
      .getByLabel("Retention: purge submissions this many days after submission")
      .fill("120");
    await owner.page.getByLabel(/Purge after the role closes/).check();
    await owner.page.getByLabel("Email sender display name").fill("Acacia Hiring Team");
    await owner.page.getByRole("button", { name: "Save settings" }).click();
    await expect(toast(owner.page)).toContainText("Settings saved");
    await owner.page.reload();
    await expect(
      owner.page.getByLabel("Retention: purge submissions this many days after submission"),
    ).toHaveValue("120");
    await expect(owner.page.getByLabel(/Purge after the role closes/)).toBeChecked();
    await expect(owner.page.getByLabel("Email sender display name")).toHaveValue(
      "Acacia Hiring Team",
    );

    const member = owner.page.getByRole("listitem").filter({ hasText: accounts.reviewer.email });
    await member.getByLabel(`Role for ${accounts.reviewer.email}`).selectOption("recruiter");
    await member.getByRole("button", { name: "Change" }).click();
    await expect(toast(owner.page)).toContainText("Member role updated");
    await member.getByRole("button", { name: "Remove" }).click();
    await expect(toast(owner.page)).toContainText("Member removed");
  });

  await test.step("capture responsive dashboards", async () => {
    const ownerMobile = await browser.newContext({
      storageState: OWNER_STATE,
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
    });
    const ownerPage = await ownerMobile.newPage();
    await ownerPage.goto("/dashboard");
    await expect(ownerPage.getByRole("heading", { name: "Placement dashboard" })).toBeVisible();
    await capture(ownerPage, "24-mobile-recruiter-dashboard.png");
    await ownerMobile.close();

    const seekerMobile = await browser.newContext({
      storageState: SEEKER_STATE,
      baseURL: BASE_URL,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
    });
    const seekerPage = await seekerMobile.newPage();
    await seekerPage.goto("/overview");
    await expect(
      seekerPage.getByRole("heading", { name: "Your application dashboard" }),
    ).toBeVisible();
    await capture(seekerPage, "25-mobile-job-seeker-overview.png");
    await seekerMobile.close();
  });

  await test.step("crypto-shred the application through the recruiter UI", async () => {
    await owner.page.goto(`/dashboard/requests/${requestId}/submissions/${submissionId}`);
    await owner.page.getByRole("button", { name: "Delete (crypto-shred)" }).click();
    await expect(toast(owner.page)).toContainText("Application data deleted");
    await expect(owner.page.getByText(/data was purged/i)).toBeVisible();
    await owner.page.goto(`/dashboard/requests/${requestId}`);
    await expect(owner.page.getByRole("link", { name: /Purged submission/ })).toBeVisible();
  });

  await test.step("validate and complete job-seeker erasure through the UI", async () => {
    const seeker = await newAuthenticatedPage(browser, SEEKER_STATE);
    await seeker.page.goto("/wallet");
    await seeker.page.getByLabel("Type DELETE to confirm").fill("delete");
    await seeker.page.getByRole("button", { name: "Erase my data" }).click();
    await expect(toast(seeker.page)).toContainText('Type "DELETE" to confirm erasure');

    await seeker.page.getByLabel("Type DELETE to confirm").fill("DELETE");
    const erasureSentAfter = Date.now();
    await seeker.page.getByRole("button", { name: "Erase my data" }).click();
    await waitForEmail({
      to: accounts.seeker.email,
      subject: "Your data has been deleted — Recruvault",
      after: erasureSentAfter,
    });
    await seeker.page.goto("/overview");
    await expect(
      seeker.page.getByRole("heading", { name: "Your application dashboard" }),
    ).toBeVisible();
    await expect(seeker.page.getByText("No applications yet", { exact: true })).toBeVisible();
    await expect(seeker.page.getByText("0 applications total", { exact: true })).toBeVisible();

    await seeker.page.goto("/documents");
    await expect(seeker.page.getByText(/No career documents yet/)).toBeVisible();
    await seeker.page.goto("/wallet");
    await expect(seeker.page.getByText("No credentials stored yet.", { exact: true })).toBeVisible();
    await expect(seeker.page.getByLabel("Discoverable by recruiters")).not.toBeChecked();
    await expect(seeker.page.getByLabel("General location")).toHaveValue("");
    await seeker.context.close();
  });

  await owner.context.close();
});
