import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { watermarkPdf } from "@/lib/watermark";

async function samplePdf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([595, 842]); // A4
  return Buffer.from(await pdf.save());
}

describe("watermarkPdf", () => {
  it("returns a valid PDF with the same page count", async () => {
    const src = await samplePdf(3);
    const out = await watermarkPdf(src, "viewer@example.com · 2026-07-09");
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("produces different bytes from the original (content stamped)", async () => {
    const src = await samplePdf(1);
    const out = await watermarkPdf(src, "trace-label");
    expect(out.equals(src)).toBe(false);
    expect(out.length).toBeGreaterThan(0);
  });
});
