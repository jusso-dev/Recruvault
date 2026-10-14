import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ListObjectVersionsCommand, PutBucketVersioningCommand } from "@aws-sdk/client-s3";
import { startObjectStore, type TestObjectStore } from "./object-store";

/**
 * With S3_DELETE_ALL_VERSIONS=true, deletion on a versioned bucket removes
 * every version and delete marker, not just the current one.
 */

let store: TestObjectStore;
let storage: typeof import("@/lib/storage");

beforeAll(async () => {
  store = await startObjectStore();
  process.env.S3_DELETE_ALL_VERSIONS = "true";
  await store.client.send(
    new PutBucketVersioningCommand({
      Bucket: store.bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  storage = await import("@/lib/storage");
});

afterAll(async () => {
  delete process.env.S3_DELETE_ALL_VERSIONS;
  await store?.stop();
});

describe("storage readiness", () => {
  it("reports the bucket as reachable", async () => {
    expect(await storage.storageReady()).toBe(true);
  });
});

describe("versioned bucket deletion", () => {
  it("removes every version of the key and leaves neighbours alone", async () => {
    const key = "org/owner/object";
    const neighbour = "org/owner/object-2";
    await store.putRaw(key, Buffer.from("v1"));
    await store.putRaw(key, Buffer.from("v2"));
    await store.putRaw(neighbour, Buffer.from("keep"));

    await storage.deleteObject(key);
    await storage.deleteObject(key); // repeat is harmless

    const versions = await store.client.send(
      new ListObjectVersionsCommand({ Bucket: store.bucket, Prefix: "org/owner/" }),
    );
    const left = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map((v) => v.Key);
    expect(left).toEqual([neighbour]);
  });
});
