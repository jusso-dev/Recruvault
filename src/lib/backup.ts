import "server-only";
import { randomUUID } from "crypto";
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { and, desc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { db } from "@/db";
import { backupConfig, backupRuns } from "@/db/schema";
import { audit } from "@/lib/audit";
import {
  checksumArchive,
  decodeFrames,
  encodeFrames,
  generateBackupKey,
  MAX_BACKUP_BYTES,
  nightlyBackupDue,
  sealBackup,
  serializeValue,
  utcDay,
  type BackupFrame,
} from "@/lib/backup-crypto";
import { unwrapLegacyDek, wrapLegacyDek } from "@/lib/crypto-legacy";
import { getLogger } from "@/lib/logger";
import { sanitizeForTelemetry } from "@/lib/redact";
import { getObjectBytes, listObjectKeys } from "@/lib/storage";

const log = getLogger("backup");
const LOCK_KEY = 814726392;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PublicBackupConfig {
  enabled: boolean;
  hourUtc: number;
  retainCount: number;
  r2AccountId: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  hasSecret: boolean;
  hasBackupKey: boolean;
}

export interface BackupRunView {
  id: string;
  trigger: string;
  status: string;
  sizeBytes: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}

function r2Client(accountId: string, accessKeyId: string, secret: string) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey: secret },
  });
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Backup failed.";
  return String(sanitizeForTelemetry(message)).slice(0, 240);
}

export async function getPublicBackupConfig(): Promise<PublicBackupConfig | null> {
  const [row] = await db.select().from(backupConfig).where(eq(backupConfig.id, "platform"));
  if (!row) return null;
  return {
    enabled: row.enabled,
    hourUtc: row.hourUtc,
    retainCount: row.retainCount,
    r2AccountId: row.r2AccountId,
    r2Bucket: row.r2Bucket,
    r2AccessKeyId: row.r2AccessKeyId,
    hasSecret: Boolean(row.r2SecretWrapped),
    hasBackupKey: Boolean(row.backupKeyWrapped),
  };
}

export async function listBackupRuns(limit = 10): Promise<BackupRunView[]> {
  return db
    .select({
      id: backupRuns.id,
      trigger: backupRuns.trigger,
      status: backupRuns.status,
      sizeBytes: backupRuns.sizeBytes,
      startedAt: backupRuns.startedAt,
      finishedAt: backupRuns.finishedAt,
      error: backupRuns.error,
    })
    .from(backupRuns)
    .orderBy(desc(backupRuns.startedAt))
    .limit(limit);
}

export async function verifyR2Access(input: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secret: string;
}): Promise<void> {
  const client = r2Client(input.accountId, input.accessKeyId, input.secret);
  await client.send(new HeadBucketCommand({ Bucket: input.bucket }));
}

export async function saveBackupConfig(input: {
  enabled: boolean;
  hourUtc: number;
  retainCount: number;
  r2AccountId: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2Secret?: string;
  updatedBy: string;
}): Promise<{ backupKey?: string }> {
  const [existing] = await db.select().from(backupConfig).where(eq(backupConfig.id, "platform"));
  const secret = input.r2Secret || (existing ? unwrapLegacyDek(existing.r2SecretWrapped).toString("utf8") : "");
  if (!secret) throw new Error("Enter the R2 secret access key.");
  await verifyR2Access({
    accountId: input.r2AccountId,
    bucket: input.r2Bucket,
    accessKeyId: input.r2AccessKeyId,
    secret,
  });

  let backupKey: string | undefined;
  let wrappedKey = existing?.backupKeyWrapped;
  if (!wrappedKey) {
    const generated = generateBackupKey();
    wrappedKey = wrapLegacyDek(generated);
    backupKey = generated.toString("base64url");
  }

  await db
    .insert(backupConfig)
    .values({
      id: "platform",
      enabled: input.enabled,
      hourUtc: input.hourUtc,
      retainCount: input.retainCount,
      r2AccountId: input.r2AccountId,
      r2Bucket: input.r2Bucket,
      r2AccessKeyId: input.r2AccessKeyId,
      r2SecretWrapped: wrapLegacyDek(Buffer.from(secret, "utf8")),
      backupKeyWrapped: wrappedKey,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: backupConfig.id,
      set: {
        enabled: input.enabled,
        hourUtc: input.hourUtc,
        retainCount: input.retainCount,
        r2AccountId: input.r2AccountId,
        r2Bucket: input.r2Bucket,
        r2AccessKeyId: input.r2AccessKeyId,
        r2SecretWrapped: wrapLegacyDek(Buffer.from(secret, "utf8")),
        backupKeyWrapped: wrappedKey,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
  return { backupKey };
}

async function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
  const pool = db.$client as Pool;
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [LOCK_KEY],
    );
    locked = Boolean(result.rows[0]?.locked);
    if (!locked) throw new Error("A backup is already running.");
    return await fn();
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    client.release();
  }
}

export async function dumpPublicDatabase(): Promise<{ table: string; rows: Record<string, unknown>[] }[]> {
  const pool = db.$client as Pool;
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    const dumped: { table: string; rows: Record<string, unknown>[] }[] = [];
    for (const table of tables.rows) {
      if (!IDENT.test(table.tablename)) continue;
      const result = await client.query<Record<string, unknown>>(
        `select * from ${quoteIdent(table.tablename)}`,
      );
      dumped.push({
        table: table.tablename,
        rows: result.rows.map((row) => serializeValue(row) as Record<string, unknown>),
      });
    }
    await client.query("COMMIT");
    return dumped;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function quoteIdent(identifier: string): string {
  if (!IDENT.test(identifier)) throw new Error("Unexpected database identifier.");
  return `"${identifier}"`;
}

export function buildBackupPlaintext(input: {
  createdAt: string;
  tables: { table: string; rows: Record<string, unknown>[] }[];
  objects: { key: string; body: Buffer }[];
}): Buffer {
  const frames: BackupFrame[] = [
    {
      type: 1,
      payload: Buffer.from(
        JSON.stringify({
          version: 1,
          createdAt: input.createdAt,
          tableCount: input.tables.length,
          objectCount: input.objects.length,
          note: "Customer encryption keys are not included. Shredded records stay unreadable.",
        }),
      ),
    },
  ];
  for (const table of input.tables) {
    frames.push({
      type: 2,
      payload: Buffer.from(JSON.stringify({ table: table.table, rows: table.rows })),
    });
  }
  for (const object of input.objects) {
    const key = Buffer.from(object.key, "utf8");
    if (key.length > 1024) throw new Error("Object key is too long to back up.");
    const header = Buffer.alloc(2);
    header.writeUInt16BE(key.length, 0);
    frames.push({ type: 3, payload: Buffer.concat([header, key, object.body]) });
  }
  return encodeFrames(frames);
}

export function readBackupPlaintext(plaintext: Buffer): {
  manifest: Record<string, unknown>;
  tables: { table: string; rows: unknown[] }[];
  objects: { key: string; body: Buffer }[];
} {
  const frames = decodeFrames(plaintext);
  const manifestFrame = frames.find((frame) => frame.type === 1);
  if (!manifestFrame) throw new Error("Backup manifest is missing.");
  const tables = frames
    .filter((frame) => frame.type === 2)
    .map((frame) => JSON.parse(frame.payload.toString("utf8")) as { table: string; rows: unknown[] });
  const objects = frames.filter((frame) => frame.type === 3).map((frame) => {
    const length = frame.payload.readUInt16BE(0);
    const key = frame.payload.subarray(2, 2 + length).toString("utf8");
    return { key, body: frame.payload.subarray(2 + length) };
  });
  return {
    manifest: JSON.parse(manifestFrame.payload.toString("utf8")) as Record<string, unknown>,
    tables,
    objects,
  };
}

export async function runBackup(trigger: "nightly" | "manual"): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const [config] = await db.select().from(backupConfig).where(eq(backupConfig.id, "platform"));
  if (!config) return { ok: false, error: "Configure R2 before running a backup." };

  const day = utcDay();
  const dedupeKey = trigger === "nightly" ? `nightly:${day}` : `manual:${randomUUID()}`;
  if (trigger === "nightly") {
    const [done] = await db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(and(eq(backupRuns.dedupeKey, dedupeKey), eq(backupRuns.status, "succeeded")));
    if (done) return { ok: false, error: "Tonight's backup already succeeded." };
    if (!nightlyBackupDue({
      enabled: config.enabled,
      hourUtc: config.hourUtc,
      now: new Date(),
      alreadySucceededToday: false,
    })) {
      return { ok: false, error: "The nightly backup hour has not been reached." };
    }
  }

  try {
    return await withBackupLock(async () => {
      const [existingRun] = await db
        .select({ id: backupRuns.id, status: backupRuns.status })
        .from(backupRuns)
        .where(eq(backupRuns.dedupeKey, dedupeKey));
      if (existingRun?.status === "succeeded") {
        return { ok: false as const, error: "Tonight's backup already succeeded." };
      }
      const run = existingRun
        ? (
            await db
              .update(backupRuns)
              .set({ status: "running", error: null, startedAt: new Date(), finishedAt: null })
              .where(eq(backupRuns.id, existingRun.id))
              .returning({ id: backupRuns.id })
          )[0]
        : (
            await db
              .insert(backupRuns)
              .values({ trigger, dedupeKey, status: "running" })
              .returning({ id: backupRuns.id })
          )[0];
      if (!run) return { ok: false as const, error: "A backup is already running." };

      try {
        const tables = await dumpPublicDatabase();
        const keys = await listObjectKeys();
        const objects: { key: string; body: Buffer }[] = [];
        for (const key of keys) objects.push({ key, body: await getObjectBytes(key) });
        const plaintext = buildBackupPlaintext({
          createdAt: new Date().toISOString(),
          tables,
          objects,
        });
        if (plaintext.length > MAX_BACKUP_BYTES) {
          throw new Error("Backup is larger than 200 MB and was not uploaded.");
        }
        const backupKey = unwrapLegacyDek(config.backupKeyWrapped);
        const archive = sealBackup(backupKey, plaintext);
        const objectKey = `recruvault/backups/${day}/${run.id}.rvbak`;
        const secret = unwrapLegacyDek(config.r2SecretWrapped).toString("utf8");
        const client = r2Client(config.r2AccountId, config.r2AccessKeyId, secret);
        await client.send(
          new PutObjectCommand({
            Bucket: config.r2Bucket,
            Key: objectKey,
            Body: archive,
            ContentType: "application/octet-stream",
          }),
        );
        await pruneBackups(client, config.r2Bucket, config.retainCount, objectKey);
        await db
          .update(backupRuns)
          .set({
            status: "succeeded",
            objectKey,
            sizeBytes: archive.length,
            checksum: checksumArchive(archive),
            finishedAt: new Date(),
            error: null,
          })
          .where(eq(backupRuns.id, run.id));
        await audit({
          actorType: "system",
          action: "backup.completed",
          targetType: "backup_run",
          targetId: run.id,
        });
        return { ok: true as const, id: run.id };
      } catch (error) {
        const message = safeError(error);
        await db
          .update(backupRuns)
          .set({ status: "failed", error: message, finishedAt: new Date() })
          .where(eq(backupRuns.id, run.id));
        log.error({ runId: run.id }, "encrypted backup failed");
        await audit({
          actorType: "system",
          action: "backup.failed",
          targetType: "backup_run",
          targetId: run.id,
        });
        return { ok: false as const, error: message };
      }
    });
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

async function pruneBackups(client: S3Client, bucket: string, retainCount: number, keepKey: string) {
  const keys: { key: string; modified: number }[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "recruvault/backups/",
        ContinuationToken: token,
      }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) keys.push({ key: item.Key, modified: item.LastModified?.getTime() ?? 0 });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const stale = keys
    .filter((item) => item.key !== keepKey)
    .sort((a, b) => b.modified - a.modified)
    .slice(retainCount - 1);
  for (const item of stale) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.key }));
  }
}

export async function nightlyBackupIfDue(): Promise<{ ran: boolean }> {
  const [config] = await db.select().from(backupConfig).where(eq(backupConfig.id, "platform"));
  if (!config?.enabled) return { ran: false };
  const day = utcDay();
  const [done] = await db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.dedupeKey, `nightly:${day}`), eq(backupRuns.status, "succeeded")));
  if (!nightlyBackupDue({
    enabled: true,
    hourUtc: config.hourUtc,
    now: new Date(),
    alreadySucceededToday: Boolean(done),
  })) {
    return { ran: false };
  }
  const result = await runBackup("nightly");
  return { ran: result.ok };
}

