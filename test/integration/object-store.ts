import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Isolated S3-compatible store for integration tests.
 *
 * With INTEGRATION_S3_ENDPOINT (plus INTEGRATION_S3_ACCESS_KEY_ID and
 * INTEGRATION_S3_SECRET_ACCESS_KEY) each suite creates and later empties and
 * removes its own bucket. Otherwise a local `minio` binary (MINIO_BINARY, PATH,
 * or Homebrew) is started on a free port with a temporary data directory and
 * synthetic credentials. A suite that cannot get a store fails; it is never
 * skipped.
 *
 * Sets S3_* / AWS_* so @/lib/storage binds to the store. Call before importing
 * modules that use storage.
 */
export type TestObjectStore = {
  bucket: string;
  client: S3Client;
  getRaw: (key: string) => Promise<Buffer>;
  putRaw: (key: string, body: Buffer) => Promise<void>;
  keys: (prefix?: string) => Promise<string[]>;
  stop: () => Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
    });
  });
}

function minioBinary(): string {
  const candidates = [
    process.env.MINIO_BINARY,
    ...(process.env.PATH ?? "").split(":").map((dir) => join(dir, "minio")),
    "/opt/homebrew/bin/minio",
    "/usr/local/bin/minio",
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("No S3 store: set INTEGRATION_S3_ENDPOINT or install minio.");
  return found;
}

async function waitForHealth(endpoint: string, proc: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`minio exited with code ${proc.exitCode}`);
    try {
      const res = await fetch(`${endpoint}/minio/health/live`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("minio did not become healthy within 30s");
}

export async function startObjectStore(): Promise<TestObjectStore> {
  let endpoint = process.env.INTEGRATION_S3_ENDPOINT;
  let accessKeyId = process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "";
  let secretAccessKey = process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "";
  let proc: ChildProcess | undefined;
  let dataDir: string | undefined;

  if (!endpoint) {
    const port = await freePort();
    const consolePort = await freePort();
    dataDir = mkdtempSync(join(tmpdir(), "rv-minio-"));
    accessKeyId = `rvtest${randomBytes(4).toString("hex")}`;
    secretAccessKey = randomBytes(16).toString("hex");
    proc = spawn(
      minioBinary(),
      ["server", dataDir, "--address", `127.0.0.1:${port}`, "--console-address", `127.0.0.1:${consolePort}`, "--quiet"],
      {
        env: { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey },
        stdio: "ignore",
      },
    );
    endpoint = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(endpoint, proc);
    } catch (err) {
      proc.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
      throw err;
    }
  }

  const bucket = `rv-it-${randomBytes(6).toString("hex")}`;
  const region = "us-east-1";
  Object.assign(process.env, {
    S3_ENDPOINT: endpoint,
    S3_FORCE_PATH_STYLE: "true",
    S3_BUCKET: bucket,
    S3_SERVER_SIDE_ENCRYPTION: "false",
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  });
  const client = new S3Client({
    endpoint,
    forcePathStyle: true,
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));

  const keys = async (prefix?: string) => {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of res.Contents ?? []) if (item.Key) out.push(item.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  };

  return {
    bucket,
    client,
    keys,
    getRaw: async (key) => {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    putRaw: async (key, body) => {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    },
    stop: async () => {
      if (proc) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 200));
        if (proc.exitCode === null) proc.kill("SIGKILL");
        if (dataDir) rmSync(dataDir, { recursive: true, force: true });
        return;
      }
      // External store: remove every version so the bucket can be deleted.
      const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]
        .filter((v) => v.Key)
        .map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
      if (objects.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    },
  };
}
