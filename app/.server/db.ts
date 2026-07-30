import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import fs from "node:fs";
import path from "node:path";
import * as schema from "~/db/schema";

export const dbPath = process.env.DATABASE_PATH ?? "./data/finance.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function connect() {
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return { sqlite, orm: drizzle(sqlite, { schema }) };
}

let conn = connect();

/** Live binding — importers always see the current connection. */
export let db: BunSQLiteDatabase<typeof schema> = conn.orm;

/** Raw bun:sqlite handle (for VACUUM / VACUUM INTO). */
export function rawSqlite() {
  return conn.sqlite;
}

/** Close the connection so the db file can be swapped, then reopen. */
export function withDbClosed<T>(fn: () => T): T {
  conn.sqlite.close();
  try {
    return fn();
  } finally {
    conn = connect();
    db = conn.orm;
  }
}

export { schema };
