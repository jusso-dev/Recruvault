import "server-only";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

/**
 * Burn a repeating, semi-transparent diagonal watermark into every page of a
 * PDF. The label carries viewer identity + timestamp so any copy that escapes
 * a view-only render is traceable back to who rendered it and when.
 *
 * Note: this stamps an overlay, not a rasterisation — the underlying text is
 * still selectable in the served bytes. It makes leaks traceable and download
 * copies marked; it is not DRM. True anti-extraction would require server-side
 * page rasterisation (a native renderer), which is out of scope here.
 */
export async function watermarkPdf(bytes: Buffer, label: string): Promise<Buffer> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 16;

  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    // Tile the label diagonally across the whole page.
    for (let y = -80; y < height + 160; y += 150) {
      for (let x = -80; x < width + 160; x += 320) {
        page.drawText(label, {
          x,
          y,
          size,
          font,
          color: rgb(0.5, 0.5, 0.5),
          opacity: 0.22,
          rotate: degrees(45),
        });
      }
    }
  }

  return Buffer.from(await pdf.save());
}
