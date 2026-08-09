import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import { db, dbPath, rawClient, schema } from "~/.server/db";
import { STARTER_CATEGORIES } from "~/db/starter-categories";

/**
 * Every table that holds real household data, in an order that happens to be
 * FK-safe for delete (children before parents) — though with
 * `defer_foreign_keys` on, order stops mattering; see `restoreBackup`.
 */
const DATA_TABLES = [
  schema.amazonMatches,
  schema.amazonOrderItems,
  schema.amazonOrders,
  schema.transferRejections,
  schema.transactionSplits,
  schema.stagedRows,
  schema.transactions,
  schema.balanceSnapshots,
  schema.csvMappings,
  schema.merchantMemory,
  schema.importBatches,
  schema.importSessions,
  schema.categories,
  schema.accounts,
] as const;

/**
 * Backups are plain SQLite files in data/backups/, named by convention:
 *   <YYYY-MM-DD_HH-mm-ss>__<label>.db
 * The label is a sanitized human note ("before-import", "pre-restore", …).
 */

export const BACKUPS_DIR = path.join(path.dirname(dbPath), "backups");

const NAME_RE = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})__([A-Za-z0-9._-]*)\.db$/;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function sanitizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 40);
}

/** Resolve a backup filename safely inside BACKUPS_DIR (no traversal). */
function backupPath(filename: string): string | null {
  if (!NAME_RE.test(filename)) return null;
  const full = path.join(BACKUPS_DIR, filename);
  return full.startsWith(BACKUPS_DIR) ? full : null;
}

export interface BackupInfo {
  filename: string;
  label: string;
  createdAt: string; // from the filename convention
  sizeBytes: number;
}

export function listBackups(): BackupInfo[] {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  return fs
    .readdirSync(BACKUPS_DIR)
    .map((filename) => {
      const m = NAME_RE.exec(filename);
      if (!m) return null;
      const stat = fs.statSync(path.join(BACKUPS_DIR, filename));
      return {
        filename,
        label: m[2] || "(no label)",
        createdAt: `${m[1].slice(0, 10)} ${m[1].slice(11).replace(/-/g, ":")}`,
        sizeBytes: stat.size,
      };
    })
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

/** Online backup of the live db (VACUUM INTO) — safe while the app is running. */
export async function createBackup(label: string): Promise<string> {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const filename = `${timestamp()}__${sanitizeLabel(label)}.db`;
  const target = path.join(BACKUPS_DIR, filename).replace(/'/g, "''");
  await rawClient().execute(`VACUUM INTO '${target}'`);
  return filename;
}

function isSqliteFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    return head.equals(SQLITE_MAGIC);
  } catch {
    return false;
  }
}

/**
 * Replace the live database with a backup. A "pre-restore" safety backup of
 * the current state is taken first.
 *
 * Under Turso, the live db is an embedded replica — the local file carries
 * replication metadata tied to the primary, so it can no longer just be
 * swapped for the backup file wholesale (that would desync the replica, not
 * restore it). Instead the backup is opened as its own standalone local
 * db, every table is read out of it, and the live tables are wiped and
 * reloaded through the normal write path in one transaction —
 * `defer_foreign_keys` lets every table's rows be deleted and reinserted in
 * any order, including the self-referencing `transactions.transferPeerId`.
 */
export async function restoreBackup(filename: string): Promise<string | null> {
  const source = backupPath(filename);
  if (!source || !fs.existsSync(source)) return "Backup not found.";
  if (!isSqliteFile(source)) return "That file is not a SQLite database.";

  await createBackup("pre-restore");

  const backupClient = createClient({ url: `file:${source}` });
  let snapshot: { table: (typeof DATA_TABLES)[number]; rows: Record<string, unknown>[] }[];
  try {
    const backupDb = drizzle(backupClient, { schema });
    snapshot = await Promise.all(
      DATA_TABLES.map(async (table) => ({
        table,
        rows: await backupDb.select().from(table as never),
      })),
    );
  } finally {
    backupClient.close();
  }

  await db.transaction(async (tx) => {
    await tx.run(sql`PRAGMA defer_foreign_keys = ON`);
    for (const { table } of snapshot) await tx.delete(table).run();
    for (const { table, rows } of snapshot) {
      if (rows.length > 0) await tx.insert(table).values(rows as never).run();
    }
  });
  return null;
}

export function deleteBackup(filename: string): string | null {
  const full = backupPath(filename);
  if (!full || !fs.existsSync(full)) return "Backup not found.";
  fs.rmSync(full);
  return null;
}

/** Import an external .db file into the backups folder (naming convention applied). */
export function importBackupFile(
  buffer: Buffer,
  originalName: string,
): { filename: string } | { error: string } {
  if (!buffer.subarray(0, 16).equals(SQLITE_MAGIC)) {
    return { error: "That file is not a SQLite database." };
  }
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const label = sanitizeLabel(originalName.replace(/\.db$/i, "")) || "imported";
  const filename = `${timestamp()}__${label}.db`;
  fs.writeFileSync(path.join(BACKUPS_DIR, filename), buffer);
  return { filename };
}

/**
 * Wipe all data (after a "pre-reset" safety backup) and reseed the starter
 * categories, leaving a fresh household.
 */
export async function clearDatabase(): Promise<void> {
  await createBackup("pre-reset");
  await db.transaction(async (tx) => {
    await tx.run(sql`PRAGMA defer_foreign_keys = ON`);
    for (const table of DATA_TABLES) await tx.delete(table).run();
    await tx.insert(schema.categories).values(STARTER_CATEGORIES).run();
  });
  // Best-effort space reclaim — an in-place VACUUM rewrites the replica's
  // local file structure, which isn't guaranteed to be safe mid-sync, so a
  // failure here must not undo the wipe above.
  try {
    await rawClient().execute("VACUUM");
  } catch {
    // ignore — the data wipe already committed
  }
}
