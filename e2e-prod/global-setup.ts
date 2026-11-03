import { createServer } from "node:net";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

const REQUIRED = [
  "DATABASE_URL",
  "APP_URL",
  "BETTER_AUTH_SECRET",
  "LOCAL_KEK",
  "BOOTSTRAP_TOKEN",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

/**
 * Stand-in for clamd that reports every INSTREAM upload clean and answers
 * PING. Production refuses SCAN_DISABLED, so uploads need a scanner; these
 * tests check browser policy, not malware detection.
 */
function startScanner(port: number) {
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffered = Buffer.concat([buffered, data]);
      if (buffered.subarray(0, 6).toString() === "zPING\0") return void socket.end("PONG\0");
      const header = "zINSTREAM\0".length;
      let offset = header;
      while (buffered.length >= offset + 4) {
        const size = buffered.readUInt32BE(offset);
        if (size === 0) return void socket.end("stream: OK\0");
        offset += 4 + size;
      }
    });
    socket.on("error", () => socket.destroy());
  });
  return new Promise<() => Promise<void>>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve(() => new Promise<void>((done) => server.close(() => done()))),
    );
  });
}

/**
 * The database must already be migrated and not yet bootstrapped. The object
 * store must be running; the bucket is created here. Values are never printed.
 */
export default async function globalSetup() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Production browser tests need: ${missing.join(", ")}`);

  const s3 = new S3Client({
    region: process.env.AWS_REGION ?? "ap-southeast-2",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
  } finally {
    s3.destroy();
  }

  // Must match CLAMAV_PORT in playwright.prod.config.ts.
  return startScanner(Number(process.env.PROD_E2E_PORT ?? 3110) + 9);
}
