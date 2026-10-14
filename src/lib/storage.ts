import "server-only";
import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "stream";

/**
 * Document storage: private S3 bucket (ap-southeast-2) with SSE-S3 (AES-256), no
 * public access. Uploads buffer through the app server so every file is
 * content-sniffed and virus-scanned before it becomes visible; reads stream
 * through an authorised route. Originals are never exposed through a public
 * path, and there is no direct browser-to-S3 access.
 *
 * New objects hold application ciphertext (see document-protect.ts); storage-
 * side encryption is an additional layer, not the document envelope.
 */

const BUCKET = process.env.S3_BUCKET ?? "recruvault-documents";
const USE_SERVER_SIDE_ENCRYPTION = process.env.S3_SERVER_SIDE_ENCRYPTION
  ? process.env.S3_SERVER_SIDE_ENCRYPTION === "true"
  : !process.env.S3_ENDPOINT;
// On a versioned bucket a plain delete only adds a delete marker. With this
// set, deletion removes every version and marker for the key.
const DELETE_ALL_VERSIONS = process.env.S3_DELETE_ALL_VERSIONS === "true";

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

/** Opaque object name. The original filename stays in the database, not the object key. */
export function opaqueStorageKey(scope: "org" | "wallet", ownerId: string) {
  return `${scope}/${ownerId}/${randomUUID()}`;
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
      // AWS S3 supports SSE-S3 without further configuration. Local MinIO does
      // not unless a KMS is configured, so compatible endpoints can opt in via
      // S3_SERVER_SIDE_ENCRYPTION=true.
      ...(USE_SERVER_SIDE_ENCRYPTION ? { ServerSideEncryption: "AES256" as const } : {}),
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

export async function listObjects(prefix?: string): Promise<{ key: string; lastModified?: Date }[]> {
  const objects: { key: string; lastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const out = await client().send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const item of out.Contents ?? []) {
      if (item.Key) objects.push({ key: item.Key, lastModified: item.LastModified });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

export async function listObjectKeys(): Promise<string[]> {
  return (await listObjects()).map((o) => o.key);
}

/** Readiness probe: the bucket is reachable with the configured credentials. Never throws. */
export async function storageReady(): Promise<boolean> {
  try {
    // Bounded so a hung endpoint fails the probe instead of stalling it.
    await client().send(new HeadBucketCommand({ Bucket: BUCKET }), {
      abortSignal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

/** True when S3 reports the key (not the bucket) as absent. */
export function isMissingObjectError(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.Code === "NoSuchKey" ||
    (e?.$metadata?.httpStatusCode === 404 && e?.name !== "NoSuchBucket")
  );
}

export async function deleteObject(storageKey: string): Promise<void> {
  if (!DELETE_ALL_VERSIONS) {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey }));
    return;
  }
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const out = await client().send(
      new ListObjectVersionsCommand({
        Bucket: BUCKET,
        Prefix: storageKey,
        KeyMarker: keyMarker,
        VersionIdMarker: versionMarker,
      }),
    );
    const versions = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])]
      .filter((v) => v.Key === storageKey && v.VersionId)
      .map((v) => ({ Key: storageKey, VersionId: v.VersionId }));
    if (versions.length > 0) {
      const res = await client().send(
        new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: versions, Quiet: true } }),
      );
      if (res.Errors?.length) throw new Error(`Version delete failed: ${res.Errors[0].Code ?? "unknown"}`);
    }
    keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
    versionMarker = out.IsTruncated ? out.NextVersionIdMarker : undefined;
  } while (keyMarker);
}
