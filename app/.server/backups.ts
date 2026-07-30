import fs from "node:fs";
import path from "node:path";
import { db, dbPath, rawSqlite, schema, withDbClosed } from "~/.server/db";
import { STARTER_CATEGORIES } from "~/db/starter-categories";

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
  rawSqlite().exec(`VACUUM INTO '${target}'`);
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
 * the current state is taken first; WAL/SHM sidecars are removed so the
 * restored file is opened cleanly.
 */
export async function restoreBackup(filename: string): Promise<string | null> {
  const source = backupPath(filename);
  if (!source || !fs.existsSync(source)) return "Backup not found.";
  if (!isSqliteFile(source)) return "That file is not a SQLite database.";

  await createBackup("pre-restore");
  withDbClosed(() => {
    fs.copyFileSync(source, dbPath);
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
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
  db.transaction((tx) => {
    // FK-safe order: children first
    tx.delete(schema.amazonMatches).run();
    tx.delete(schema.amazonOrderItems).run();
    tx.delete(schema.amazonOrders).run();
    tx.delete(schema.transactionSplits).run();
    tx.delete(schema.stagedRows).run();
    tx.delete(schema.transactions).run();
    tx.delete(schema.balanceSnapshots).run();
    tx.delete(schema.csvMappings).run();
    tx.delete(schema.merchantMemory).run();
    tx.delete(schema.importBatches).run();
    tx.delete(schema.categories).run();
    tx.delete(schema.accounts).run();
    for (const c of STARTER_CATEGORIES) {
      tx.insert(schema.categories).values(c).run();
    }
  });
  rawSqlite().exec("VACUUM");
}
