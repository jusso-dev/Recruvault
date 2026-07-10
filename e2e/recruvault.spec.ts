import { mkdir } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  createSecureInvitation,
  emailVerificationToken,
  passwordResetTokenForEmail,
  requestIdForTitle,
  setUserEmailVerified,
  setKnownOtp,
  submissionIdForRequest,
} from "./db-helpers";

test.describe.configure({ mode: "serial" });

const AUTH_DIR = ".playwright/auth";
const SCREENSHOT_DIR = "docs/screenshots";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OWNER_STATE = `${AUTH_DIR}/owner.json`;
const REVIEWER_STATE = `${AUTH_DIR}/reviewer.json`;
const SEEKER_STATE = `${AUTH_DIR}/seeker.json`;

const accounts = {
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
const knownOtp = "246810";

let requestId = "";
let invitationToken = "";
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
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(account.email, { exact: true })).toBeVisible();
  if (type === "org") {
    await page.getByRole("button", { name: "Resend verification email" }).click();
    await expect(toast(page)).toContainText("Verification email sent");
  }
  const token = await emailVerificationToken(account.email);
  const callbackURL = type === "org" ? "/onboarding" : "/overview";
  // Model the common case where the email is opened outside the browser that
  // submitted the form. Verification must establish a fresh session itself.
  await page.context().clearCookies();
  await page.goto(
    `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(callbackURL)}`,
  );
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
    await resetPage.getByRole("button", { name: "Send reset link" }).click();
    await expect(resetPage.getByRole("heading", { name: "Check your email" })).toBeVisible();

    const token = await passwordResetTokenForEmail(accounts.recovery.email);
    await resetPage.goto(
      `/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent("/reset-password")}`,
    );
    await resetPage.waitForURL(`**/reset-password?token=${token}`);
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
    await page.getByLabel("Minimum salary or rate").fill("1200");
    await page.getByLabel("Maximum salary or rate").fill("1400");
    await page.getByLabel("Security clearance level").check();
    await page.getByLabel("Security clearance ID").check();
    await page.getByLabel("Link expiry").fill("2027-12-31");
    await page.getByLabel(/List this role/).check();
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

    invitationToken = await createSecureInvitation(requestId, accounts.seeker.email);
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
    await page.getByLabel(/PDF, Word, or image/).setInputFiles(pdfFile("Jordan-Lee-Resume.pdf"));
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(toast(page)).toContainText("Uploaded");
    await expect(page.getByText("Jordan-Lee-Resume.pdf")).toBeVisible();

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
    await page.getByRole("button", { name: "Save alert preferences" }).click();
    await expect(toast(page)).toContainText("Job alert preferences saved");
    await expect(page.getByLabel("Keyword")).toBeVisible();
    await expect(page.getByLabel("Location", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Minimum salary/rate")).toBeVisible();
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
    await page.goto(`/r/${invitationToken}`);
    await expect(page.getByRole("heading", { name: new RegExp(organisationName) })).toBeVisible();
    await capture(page, "14-secure-invitation.png");
    await page.getByRole("button", { name: "Send me the code" }).click();
    await expect(toast(page)).toContainText("Code sent");
    await setKnownOtp(invitationToken, knownOtp);
    await page.getByLabel("Enter the 6-digit code").fill(knownOtp);
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL(`**/r/${invitationToken}/respond`);
    await expect(page.getByRole("heading", { name: roleTitle })).toBeVisible();
    await capture(page, "15-application-form.png");

    await page.getByLabel(/Security clearance level/).selectOption("nv1");
    await page.getByLabel(/Security clearance ID/).fill("AGSVA-CL-2048");
    await page.getByLabel(/Resume \/ CV/).setInputFiles(pdfFile("Jordan-Lee-Resume.pdf"));
    await page
      .getByLabel(/Cover letter \/ suitability statement/)
      .setInputFiles(pdfFile("Acacia-Suitability-Statement.pdf"));
    await page.getByLabel(/I consent to/).check();
    await page.getByRole("button", { name: "Submit securely" }).click();
    await page.waitForURL(`**/r/${invitationToken}/done`);
    await expect(page.getByRole("heading", { name: "Submitted securely" })).toBeVisible();
    await capture(page, "16-application-submitted.png");
    submissionId = await submissionIdForRequest(requestId);
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
      ["shortlisted", "Shortlisted"],
      ["interview", "Interview"],
      ["offer", "Offer"],
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
    await reviewer.context.close();
  });

  await test.step("exercise role, API key, and member update/delete controls", async () => {
    await owner.page.goto(`/dashboard/requests/${requestId}`);
    await owner.page.getByLabel("Status").selectOption("closed");
    await owner.page.getByRole("button", { name: "Update" }).click();
    await expect(toast(owner.page)).toContainText("Role status updated");
    await owner.page.getByLabel("Status").selectOption("open");
    await owner.page.getByRole("button", { name: "Update" }).click();

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

  await owner.context.close();
});
