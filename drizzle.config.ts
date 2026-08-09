import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// scripts/desktop/build.ts sets this to force a push against a throwaway
// local file (for the schema dump it embeds in the desktop binary) even
// when TURSO_DB_URL is configured — it must never push at the live primary.
const localOnly = process.env.SPROUT_LOCAL_SCHEMA_DUMP === "1";
const tursoUrl = localOnly ? undefined : process.env.TURSO_DB_URL;

export default tursoUrl
  ? defineConfig({
      schema: "./app/db/schema.ts",
      out: "./drizzle",
      dialect: "turso",
      dbCredentials: {
        url: tursoUrl,
        authToken: process.env.TURSO_DB_KEY,
      },
    })
  : defineConfig({
      schema: "./app/db/schema.ts",
      out: "./drizzle",
      dialect: "sqlite",
      dbCredentials: {
        url: process.env.DATABASE_PATH ?? "./data/finance.db",
      },
    });
