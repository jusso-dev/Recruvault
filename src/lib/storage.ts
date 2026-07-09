import "server-only";
import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";

/**
 * Document storage: private S3 bucket (ap-southeast-2) with SSE-KMS, no
 * public access. Objects are reached only through short-lived presigned URLs
 * issued after authorisation checks, or streamed through an authorised route.
 * Originals are never exposed through a public path.
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

/** Short-lived presigned PUT for direct browser upload. */
export async function presignUpload(storageKey: string, contentType: string) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: storageKey,
    ContentType: contentType,
    ServerSideEncryption: "aws:kms",
    ...(process.env.KMS_KEY_ID ? { SSEKMSKeyId: process.env.KMS_KEY_ID } : {}),
  });
  return getSignedUrl(client(), cmd, { expiresIn: 300 });
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
      ServerSideEncryption: "aws:kms",
      ...(process.env.KMS_KEY_ID ? { SSEKMSKeyId: process.env.KMS_KEY_ID } : {}),
    }),
  );
}

/** Short-lived presigned GET, issued only after an authorisation check. */
export async function presignDownload(storageKey: string, fileName?: string) {
  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: storageKey,
    ...(fileName
      ? { ResponseContentDisposition: `attachment; filename="${fileName}"` }
      : {}),
  });
  return getSignedUrl(client(), cmd, { expiresIn: 120 });
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
