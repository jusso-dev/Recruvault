/**
 * Restore an encrypted Recruvault backup into an ISOLATED database and print
 * counts only. Never point this at production.
 *
 *   RESTORE_DATABASE_URL=postgres://…/recruvault_restore \
 *   BACKUP_KEY_FILE=/secure/path/backup.key \
 *   npx tsx scripts/restore-backup.ts ./archive.rvbak [--truncate] [--objects-dir ./restored-objects]
 *
 * The backup key is read from a file (or stdin when BACKUP_KEY_FILE is "-"),
 * never from argv, and is never printed. Customer encryption keys are not
 * needed to restore and are not accepted here: restored records stay
 * ciphertext until their owner unlocks them in a restored app instance.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { openBackupArchive, restoreIntoDatabase } from "../src/lib/backup-restore";

async function readKey(): Promise<string> {
  const source = process.env.BACKUP_KEY_FILE;
  if (!source) throw new Error("Set BACKUP_KEY_FILE to the file holding the backup key (or - for stdin).");
  if (source !== "-") return (await readFile(source, "utf8")).trim();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function sameDatabase(a: string, b: string | undefined) {
  if (!b) return false;
  const left = new URL(a);
  const right = new URL(b);
  return left.host === right.host && left.pathname === right.pathname;
}

async function main() {
  const [archivePath, ...flags] = process.argv.slice(2);
  const target = process.env.RESTORE_DATABASE_URL;
  if (!archivePath || !target) {
    throw new Error("Usage: RESTORE_DATABASE_URL=… BACKUP_KEY_FILE=… tsx scripts/restore-backup.ts <archive> [--truncate] [--objects-dir dir]");
  }
  if (sameDatabase(target, process.env.DATABASE_URL)) {
    throw new Error("RESTORE_DATABASE_URL must not be the live DATABASE_URL.");
  }
  const objectsAt = flags.indexOf("--objects-dir");
  const objectsDir = objectsAt >= 0 ? resolve(flags[objectsAt + 1] ?? "") : undefined;

  const backup = openBackupArchive(await readFile(archivePath), await readKey());
  const client = new Client({ connectionString: target, options: "-c TimeZone=UTC" });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    const started = Date.now();
    const report = await restoreIntoDatabase(client, backup, {
      truncate: flags.includes("--truncate"),
      writeObject: objectsDir
        ? async (key, body) => {
            const path = resolve(join(objectsDir, key));
            if (!path.startsWith(objectsDir + sep)) throw new Error("Unsafe object key in backup.");
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writeFile(path, body, { mode: 0o600 });
          }
        : undefined,
    });
    console.log(
      JSON.stringify(
        {
          createdAt: backup.manifest.createdAt,
          tables: report.tables.length,
          rows: report.tables.reduce((sum, table) => sum + table.rows, 0),
          perTable: report.tables,
          skippedTables: report.skippedTables,
          droppedColumns: report.droppedColumns,
          objects: report.objects,
          seconds: Math.round((Date.now() - started) / 1000),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // Error messages here never include key material; keep them short.
  console.error(`Restore failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
