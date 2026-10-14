import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue({ data: { id: "test-delivery" }, error: null }),
}));

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
}));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: mocks.info }) }));
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

import { sendEmail } from "@/lib/email";

const message = {
  to: "candidate@example.test",
  subject: "Test verification",
  heading: "Verify your email",
  body: "Synthetic test message",
  code: "654321",
  ctaUrl: "https://example.test/r/test-only-token",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("PLAYWRIGHT_TEST", "0");
});

afterEach(() => vi.unstubAllEnvs());

describe("email secret handling", () => {
  it.each(["0", "1"])("fails closed without a production provider (test mailbox flag %s)", async (flag) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLAYWRIGHT_TEST", flag);

    await expect(sendEmail(message)).rejects.toThrow("Email delivery is not configured.");
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("uses the production provider even when the test mailbox flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLAYWRIGHT_TEST", "1");
    vi.stubEnv("RESEND_API_KEY", "unit-test-provider-key");

    await expect(sendEmail(message)).resolves.toBe("test-delivery");
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("publishes complete owner-only test emails with an atomic rename", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PLAYWRIGHT_TEST", "1");

    await expect(sendEmail(message)).resolves.toMatch(/^playwright-/);
    const [temporaryPath, payload, options] = mocks.writeFile.mock.calls[0];
    expect(temporaryPath).toMatch(/\.json\.tmp$/);
    expect(JSON.parse(payload)).toMatchObject({ to: message.to, code: message.code, ctaUrl: message.ctaUrl });
    expect(options).toEqual({ encoding: "utf8", mode: 0o600 });
    expect(mocks.rename).toHaveBeenCalledWith(temporaryPath, temporaryPath.slice(0, -4));
    expect(mocks.writeFile.mock.invocationCallOrder[0]).toBeLessThan(mocks.rename.mock.invocationCallOrder[0]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
