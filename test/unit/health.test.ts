import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  storageReady: vi.fn(),
  scannerReady: vi.fn(),
  outboxStats: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { execute: mocks.execute } }));
vi.mock("@/lib/storage", () => ({ storageReady: mocks.storageReady }));
vi.mock("@/lib/scan", () => ({ scannerReady: mocks.scannerReady }));
vi.mock("@/lib/outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/outbox")>()),
  outboxStats: mocks.outboxStats,
}));

import { GET } from "@/app/api/health/route";

const drained = { pending: 0, due: 0, dead: 0, oldestPendingSeconds: 0 };

async function health() {
  const res = await GET();
  return { code: res.status, body: await res.json() };
}

describe("readiness", () => {
  beforeEach(() => {
    mocks.execute.mockResolvedValue([]);
    mocks.storageReady.mockResolvedValue(true);
    mocks.scannerReady.mockResolvedValue(true);
    mocks.outboxStats.mockResolvedValue(drained);
  });

  it("is ok when every dependency answers and jobs drain", async () => {
    expect(await health()).toEqual({
      code: 200,
      body: { status: "ok", check: "readiness", database: "ok", storage: "ok", scanner: "ok", jobs: "ok" },
    });
  });

  it("is degraded while the scanner is down", async () => {
    mocks.scannerReady.mockResolvedValue(false);
    const { code, body } = await health();
    expect(code).toBe(200);
    expect(body).toMatchObject({ status: "degraded", scanner: "unavailable", jobs: "ok" });
  });

  it("is degraded when outbox events stop draining or dead-letter", async () => {
    mocks.outboxStats.mockResolvedValue({ ...drained, pending: 1, oldestPendingSeconds: 901 });
    expect((await health()).body).toMatchObject({ status: "degraded", jobs: "backlog" });

    mocks.outboxStats.mockResolvedValue({ ...drained, dead: 1 });
    expect((await health()).body).toMatchObject({ status: "degraded", jobs: "backlog" });

    mocks.outboxStats.mockResolvedValue({ ...drained, pending: 3, oldestPendingSeconds: 900 });
    expect((await health()).body).toMatchObject({ status: "ok", jobs: "ok" });
  });

  it("is unavailable without the database", async () => {
    mocks.execute.mockRejectedValue(new Error("connection refused"));
    mocks.outboxStats.mockRejectedValue(new Error("connection refused"));
    const { code, body } = await health();
    expect(code).toBe(503);
    expect(body).toMatchObject({ status: "unavailable", database: "unavailable", jobs: "unavailable" });
  });
});
