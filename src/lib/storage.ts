import "server-only";
import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "stream";

/**
 * Document storage: private S3 bucket (ap-southeast-2) with SSE-S3 (AES-256), no
 * public access. Uploads buffer through the app server so every file is
 * content-sniffed and virus-scanned before it becomes visible; reads stream
 * through an authorised route. Originals are never exposed through a public
 * path, and there is no direct browser-to-S3 access.
 */

const BUCKET = process.env.S3_BUCKET ?? "recruvault-documents";

let s3: S3Client | undefined;
function client() {
  s3 ??= new S3Client({
    region: process.env.AWS_REGION ?? "ap-southeast-2",
    ...(process.env.S3_ENDPOINT
      ? {
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
        }
      : {}),
  });
  return s3;
}

export function newStorageKey(scope: "org" | "wallet", ownerId: string, fileName: string) {
  const safe = fileName.replace(/[^\w.-]+/g, "_").slice(-80);
  return `${scope}/${ownerId}/${randomUUID()}/${safe}`;
}

/** Server-side upload (small files pass through the app server). */
export async function putObjectBytes(
  storageKey: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: storageKey,
      Body: bytes,
      ContentType: contentType,
      // SSE-S3 (AES-256) — provider-managed at-rest encryption that also works
      // on MinIO. Objects hold only ciphertext (fields are already envelope
      // encrypted before upload); this is defence in depth for the bucket.
      ServerSideEncryption: "AES256",
    }),
  );
}

/** Server-side stream for in-browser rendering through an authorised route. */
export async function getObjectStream(storageKey: string): Promise<{
  body: Readable;
  contentType?: string;
  contentLength?: number;
}> {
  const out = await client().send(
    new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }),
  );
  return {
    body: out.Body as Readable,
    contentType: out.ContentType,
    contentLength: out.ContentLength,
  };
}

export async function getObjectBytes(storageKey: string): Promise<Buffer> {
  const out = await client().send(
    new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }),
  );
  return Buffer.from(await out.Body!.transformToByteArray());
}

export async function deleteObject(storageKey: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey }));
}
