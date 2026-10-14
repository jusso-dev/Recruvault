import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { dataKeys, deletionTasks, documents, requests } from "@/db/schema";
import { setupMigratedDatabase } from "./harness";
import { startObjectStore, type TestObjectStore } from "./object-store";
import { asBrowser, newBrowser, signUpVerified, type Browser } from "./request-context";
import { samplePdf } from "./fixtures";

vi.mock("next/headers", async () => (await import("./request-context")).nextHeadersMock);
vi.mock("@/lib/email", async () => (await import("./request-context")).emailMock);
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * #27/#32: the createRequest Server Action stores the JD as ciphertext and
 * commits it with the request. If the transaction fails, the JD's key is
 * shredded and its object queued for durable deletion.
 */

const TOKEN = "bt-" + "5e".repeat(24);
const ORG_KEY = "Zx9Cv8Bn7Mq6Wr5Et4Yu3Io2Pa1Sd0Fg9Hj8Kl7Lz6Q";

let db: typeof import("@/db").db;
let stopDb: () => Promise<void>;
let store: TestObjectStore;
let requestActions: typeof import("@/actions/requests");
let deletion: typeof import("@/lib/deletion-queue");
let owner: Browser;

function roleForm(title: string, marker: string) {
  const data = new FormData();
  data.set("title", title);
  data.append("fields", "resume");
  data.set("jd", new File([new Uint8Array(samplePdf(marker))], "role.pdf", { type: "application/pdf" }));
  return data;
}

beforeAll(async () => {
  process.env.LOCAL_KEK = "5e".repeat(32);
  process.env.BOOTSTRAP_TOKEN = TOKEN;
  process.env.SCAN_DISABLED = "true";
  delete process.env.ALLOW_RECRUITER_SIGNUP;
  store = await startObjectStore();
  ({ db, stop: stopDb } = await setupMigratedDatabase());
  requestActions = await import("@/actions/requests");
  deletion = await import("@/lib/deletion-queue");

  owner = newBrowser();
  await signUpVerified(owner, "jd-owner@example.invalid");
  const { completePlatformSetup } = await import("@/actions/setup");
  const setup = new FormData();
  for (const [k, v] of Object.entries({
    organisationName: "JD Org",
    bootstrapToken: TOKEN,
    keyMode: "import",
    encryptionKey: ORG_KEY,
    encryptionKeyConfirm: ORG_KEY,
    keyBackupAck: "yes",
  })) {
    setup.set(k, v);
  }
  const result = await asBrowser(owner, () => completePlatformSetup(setup));
  expect(result.ok).toBe(true);
});

afterAll(async () => {
  delete process.env.SCAN_DISABLED;
  await stopDb?.();
  await store?.stop();
});

describe("createRequest JD upload", () => {
  it("commits the encrypted JD with the request", async () => {
    const result = await asBrowser(owner, () => requestActions.createRequest(roleForm("Role A", "JD-OK-MARKER")));
    expect(result.ok).toBe(true);
    const [request] = await db.select().from(requests).where(eq(requests.id, result.id!));
    const [doc] = await db.select().from(documents).where(eq(documents.id, request.jdDocumentId!));
    expect(doc.kind).toBe("jd");
    expect(doc.envelopeVersion).toBeGreaterThan(0);
    expect((await store.getRaw(doc.storageKey)).includes(Buffer.from("JD-OK-MARKER"))).toBe(false);
  });

  it("shreds the key and queues the object when the transaction fails", async () => {
    const before = new Set(await store.keys("org/"));
    const documentsBefore = (await db.select().from(documents)).length;
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("injected database failure"));
    await expect(
      asBrowser(owner, () => requestActions.createRequest(roleForm("Role B", "JD-FAIL-MARKER"))),
    ).rejects.toThrow("injected database failure");
    spy.mockRestore();

    expect((await db.select().from(documents)).length).toBe(documentsBefore);
    const added = (await store.keys("org/")).filter((k) => !before.has(k));
    expect(added).toHaveLength(1);
    const [task] = await db.select().from(deletionTasks).where(eq(deletionTasks.storageKey, added[0]));
    expect(task.state).toBe("pending");
    const shredded = await db.select().from(dataKeys).where(eq(dataKeys.purpose, "jd"));
    expect(shredded.filter((k) => k.shreddedAt)).toHaveLength(1);

    await deletion.processDeletionTasks();
    expect(await store.keys(added[0])).toHaveLength(0);
  });
});
