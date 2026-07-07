import "server-only";
import { Socket } from "net";

/**
 * Virus scanning via a ClamAV clamd daemon (INSTREAM protocol). Uploaded
 * files stay in "pending" until scanned clean; the recruiter never sees an
 * unscanned document. SCAN_DISABLED=true is a dev-only escape hatch.
 */

const CHUNK = 64 * 1024;

export type ScanResult = "clean" | "infected" | "error";

export async function scanBytes(bytes: Buffer): Promise<ScanResult> {
  if (process.env.SCAN_DISABLED === "true") {
    console.warn("[scan] SCAN_DISABLED=true — marking clean without scanning (dev only)");
    return "clean";
  }

  const host = process.env.CLAMAV_HOST ?? "localhost";
  const port = Number(process.env.CLAMAV_PORT ?? 3310);

  return new Promise<ScanResult>((resolve) => {
    const socket = new Socket();
    let response = "";

    socket.setTimeout(60_000);
    socket.on("timeout", () => {
      socket.destroy();
      resolve("error");
    });
    socket.on("error", () => resolve("error"));
    socket.on("data", (d) => {
      response += d.toString();
    });
    socket.on("close", () => {
      if (response.includes("OK")) resolve("clean");
      else if (response.includes("FOUND")) resolve("infected");
      else resolve("error");
    });

    socket.connect(port, host, () => {
      socket.write("zINSTREAM\0");
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const chunk = bytes.subarray(i, i + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      }
      const end = Buffer.alloc(4);
      end.writeUInt32BE(0, 0);
      socket.write(end);
    });
  });
}

/**
 * Content sniffing: verify the uploaded bytes actually match an allowed type,
 * regardless of the declared Content-Type or extension.
 */
export function sniffContentType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}
