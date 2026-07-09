import { describe, expect, it } from "vitest";
import { eventHash, GENESIS, verifyChainRows } from "@/lib/audit";

/** Build a valid, well-linked chain of `n` events starting from GENESIS. */
function buildChain(n: number) {
  const rows = [];
  let prevHash = GENESIS;
  for (let seq = 1; seq <= n; seq++) {
    const e = {
      orgId: "org-1",
      actorType: "org_user",
      actorId: `user-${seq}`,
      action: "record.viewed",
      targetType: "submission",
      targetId: `sub-${seq}`,
    };
    const hashedAt = `2026-07-09T00:00:0${seq}.000Z`;
    const hash = eventHash(prevHash, seq, e, hashedAt);
    rows.push({ ...e, seq, prevHash, hash, hashedAt });
    prevHash = hash;
  }
  return rows;
}

describe("verifyChainRows", () => {
  it("accepts an empty chain", () => {
    expect(verifyChainRows([])).toEqual({ ok: true });
  });

  it("accepts a well-formed chain and reports the tip", () => {
    const rows = buildChain(3);
    const res = verifyChainRows(rows);
    expect(res.ok).toBe(true);
    expect(res.lastSeq).toBe(3);
    expect(res.lastHash).toBe(rows[2].hash);
  });

  it("detects broken linkage (prevHash rewired)", () => {
    const rows = buildChain(3);
    rows[2].prevHash = GENESIS;
    const res = verifyChainRows(rows);
    expect(res.ok).toBe(false);
    expect(res.brokenAtSeq).toBe(3);
  });

  it("detects content tampering (row edited in place)", () => {
    const rows = buildChain(3);
    rows[1].action = "record.exported"; // hash no longer recomputes
    const res = verifyChainRows(rows);
    expect(res.ok).toBe(false);
    expect(res.brokenAtSeq).toBe(2);
  });

  it("verifies a slice from a checkpoint hash", () => {
    const rows = buildChain(5);
    const tail = rows.slice(2); // seqs 3..5
    const res = verifyChainRows(tail, rows[1].hash);
    expect(res.ok).toBe(true);
    expect(res.lastSeq).toBe(5);
  });

  it("rejects a slice whose starting prevHash does not match", () => {
    const rows = buildChain(5);
    const tail = rows.slice(2);
    const res = verifyChainRows(tail, GENESIS);
    expect(res.ok).toBe(false);
    expect(res.brokenAtSeq).toBe(3);
  });
});
