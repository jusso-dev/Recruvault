import { readdir, readFile } from "node:fs/promises";

const OUTBOX = ".playwright/outbox";

export interface TestEmail {
  to: string;
  subject: string;
  ctaUrl: string | null;
  code: string | null;
  createdAt: string;
}

async function emails(): Promise<TestEmail[]> {
  const files = await readdir(OUTBOX).catch(() => [] as string[]);
  const rows = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(`${OUTBOX}/${file}`, "utf8")) as TestEmail),
  );
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function waitForEmail({
  to,
  subject,
  after = 0,
}: {
  to: string;
  subject: string | RegExp;
  after?: number;
}) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const row = (await emails()).find(
      (email) =>
        email.to === to.toLowerCase() &&
        new Date(email.createdAt).getTime() >= after &&
        (typeof subject === "string" ? email.subject === subject : subject.test(email.subject)),
    );
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No test email arrived for ${to} with subject ${String(subject)}.`);
}
