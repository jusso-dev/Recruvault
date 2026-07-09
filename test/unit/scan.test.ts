import { describe, expect, it } from "vitest";
import { sniffContentType } from "@/lib/scan";

const pad = (head: number[]) => Buffer.concat([Buffer.from(head), Buffer.alloc(16)]);

describe("sniffContentType magic-byte detection", () => {
  it("detects PDF", () => {
    expect(sniffContentType(pad([...Buffer.from("%PDF-1.7")]))).toBe("application/pdf");
  });

  it("detects JPEG", () => {
    expect(sniffContentType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    expect(sniffContentType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
  });

  it("detects WEBP (RIFF....WEBP)", () => {
    const bytes = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP"),
      Buffer.alloc(4),
    ]);
    expect(sniffContentType(bytes)).toBe("image/webp");
  });

  it("returns null for too-short input", () => {
    expect(sniffContentType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("returns null for an unrecognised type (e.g. spoofed extension)", () => {
    expect(sniffContentType(pad([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // MZ / .exe
  });
});
