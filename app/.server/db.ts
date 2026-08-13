import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "~/db/schema";

export const dbPath = process.env.DATABASE_PATH ?? "./data/finance.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Turso is optional — unset TURSO_DB_URL/TURSO_DB_KEY and this is a plain
// local libSQL file, same as before, no network involved. Set them and it
// becomes an embedded replica: reads stay local, writes delegate to the
// Turso primary over the network.
const syncUrl = process.env.TURSO_DB_URL;
const authToken = process.env.TURSO_DB_KEY;

/** Whether the local file is managed as a replica of a Turso primary. */
export const isEmbeddedReplica = Boolean(syncUrl);

const client: Client = createClient({
  url: `file:${dbPath}`,
  ...(syncUrl ? { syncUrl, authToken } : {}),
});
if (syncUrl) await client.sync();
await client.execute("PRAGMA foreign_keys = ON;");

export const db: LibSQLDatabase<typeof schema> = drizzle(client, { schema });

/** Raw libSQL client handle (for VACUUM / VACUUM INTO). */
export function rawClient(): Client {
  return client;
}

export { schema };
