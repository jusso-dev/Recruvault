import type { ClientBase } from "pg";
import { BackupFormatError, decodeBackupKey, decodeFrames, openBackup, reviveValue } from "@/lib/backup-crypto";

/**
 * Restore an encrypted backup archive into an isolated, already-migrated
 * PostgreSQL database. Ciphertext and wrapped keys are copied as-is: nothing
 * here decrypts a record, and shredded keys (wrapped_key = null) stay null, so
 * a restore cannot resurrect access the deletion policy removed. Reports are
 * counts only. No `server-only` or `@/db` import so the operator script can
 * run outside Next.js.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHUNK = 500;

export interface ParsedBackup {
  manifest: Record<string, unknown>;
  tables: { table: string; rows: Record<string, unknown>[] }[];
  objects: { key: string; body: Buffer }[];
}

export interface RestoreReport {
  tables: { table: string; rows: number }[];
  skippedTables: string[];
  droppedColumns: number;
  objects: number;
}

function quote(identifier: string) {
  if (!IDENT.test(identifier)) throw new BackupFormatError("Unexpected identifier in backup.");
  return `"${identifier}"`;
}

export function openBackupArchive(archive: Buffer, backupKey: string): ParsedBackup {
  const frames = decodeFrames(openBackup(decodeBackupKey(backupKey), archive));
  const manifestFrame = frames.find((frame) => frame.type === 1);
  if (!manifestFrame) throw new BackupFormatError("Backup manifest is missing.");
  return {
    manifest: JSON.parse(manifestFrame.payload.toString("utf8")) as Record<string, unknown>,
    tables: frames
      .filter((frame) => frame.type === 2)
      .map((frame) => JSON.parse(frame.payload.toString("utf8")) as ParsedBackup["tables"][number]),
    objects: frames
      .filter((frame) => frame.type === 3)
      .map((frame) => {
        const length = frame.payload.readUInt16BE(0);
        return {
          key: frame.payload.subarray(2, 2 + length).toString("utf8"),
          body: frame.payload.subarray(2 + length),
        };
      }),
  };
}

/** Parents before children, from the target's foreign keys. */
async function insertOrder(client: ClientBase, tables: string[]): Promise<string[]> {
  const fks = await client.query<{ child: string; parent: string }>(
    `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
       from pg_constraint c
       join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public'`,
  );
  const strip = (name: string) => name.replace(/^public\./, "").replace(/"/g, "");
  const deps = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const fk of fks.rows) {
    const child = strip(fk.child);
    const parent = strip(fk.parent);
    if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter((table) => !placed.has(table) && [...deps.get(table)!].every((p) => placed.has(p)));
    if (ready.length === 0) throw new BackupFormatError("Backup tables have a foreign-key cycle.");
    for (const table of ready) {
      ordered.push(table);
      placed.add(table);
    }
  }
  return ordered;
}

export async function restoreIntoDatabase(
  client: ClientBase,
  backup: ParsedBackup,
  options: { truncate?: boolean; writeObject?: (key: string, body: Buffer) => Promise<void> } = {},
): Promise<RestoreReport> {
  const columns = await client.query<{ table_name: string; column_name: string; data_type: string }>(
    `select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'`,
  );
  const target = new Map<string, Map<string, string>>();
  for (const row of columns.rows) {
    if (!target.has(row.table_name)) target.set(row.table_name, new Map());
    target.get(row.table_name)!.set(row.column_name, row.data_type);
  }

  const restorable = backup.tables.filter((entry) => target.has(entry.table));
  const report: RestoreReport = {
    tables: [],
    skippedTables: backup.tables.filter((entry) => !target.has(entry.table)).map((entry) => entry.table),
    droppedColumns: 0,
    objects: 0,
  };

  await client.query("BEGIN");
  try {
    const names = [...target.keys()].filter((name) => IDENT.test(name));
    if (options.truncate) {
      await client.query(`truncate ${names.map(quote).join(", ")} cascade`);
    } else {
      for (const name of names) {
        const existing = await client.query(`select 1 from ${quote(name)} limit 1`);
        if (existing.rowCount) {
          throw new BackupFormatError("The target database is not empty. Restore only into an isolated database.");
        }
      }
    }
    const byName = new Map(restorable.map((entry) => [entry.table, entry]));
    for (const table of await insertOrder(client, [...byName.keys()])) {
      const entry = byName.get(table)!;
      const types = target.get(table)!;
      const backupColumns = [...new Set(entry.rows.flatMap((row) => Object.keys(row)))];
      const used = backupColumns.filter((column) => types.has(column) && IDENT.test(column));
      report.droppedColumns += backupColumns.length - used.length;
      for (let start = 0; start < entry.rows.length; start += CHUNK) {
        const chunk = entry.rows.slice(start, start + CHUNK);
        const params: unknown[] = [];
        const tuples = chunk.map((row) => {
          const slots = used.map((column) => {
            let value = reviveValue(row[column]);
            const type = types.get(column);
            if (value != null && (type === "json" || type === "jsonb")) value = JSON.stringify(value);
            params.push(value ?? null);
            return `$${params.length}`;
          });
          return `(${slots.join(", ")})`;
        });
        if (used.length === 0 || tuples.length === 0) continue;
        await client.query(
          `insert into ${quote(table)} (${used.map(quote).join(", ")}) values ${tuples.join(", ")}`,
          params,
        );
      }
      report.tables.push({ table, rows: entry.rows.length });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  for (const object of backup.objects) {
    await options.writeObject?.(object.key, object.body);
    report.objects += 1;
  }
  return report;
}
