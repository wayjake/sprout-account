/**
 * Desktop entry — compiled by `bun build --compile` into a single arm64 binary.
 * Boots the database, serves the built app, and opens a Chrome app-mode window.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createRequestHandler } from "react-router";
import { STARTER_CATEGORIES } from "../../app/db/starter-categories";
// Generated at build time — embedded into the binary:
import schemaSql from "./schema.generated.sql" with { type: "text" };
import { assetMap } from "./assets.generated";

// ——— Window configuration (tweak freely) ———
const WINDOW = {
  width: Number(process.env.SPROUT_WINDOW_WIDTH ?? 1280),
  height: Number(process.env.SPROUT_WINDOW_HEIGHT ?? 900),
  x: Number(process.env.SPROUT_WINDOW_X ?? 120),
  y: Number(process.env.SPROUT_WINDOW_Y ?? 80),
};

const HOME = process.env.HOME ?? "~";
const APP_DIR =
  process.env.SPROUT_HOME ??
  path.join(HOME, "Library", "Application Support", "Sprout Account");
fs.mkdirSync(APP_DIR, { recursive: true });

// Always pin the ledger location (SPROUT_DB_PATH to override). A plain
// DATABASE_PATH is deliberately ignored — Bun auto-loads .env files from
// whatever directory the binary is launched in, which would silently point
// the desktop app at a stray dev database.
process.env.DATABASE_PATH =
  process.env.SPROUT_DB_PATH ?? path.join(APP_DIR, "finance.db");

// ——— First-run bootstrap: create schema + starter categories ———
// Skipped when Turso is configured (TURSO_DB_URL / TURSO_DB_KEY, picked up
// from a stray .env same as SPROUT_DB_PATH's sibling knobs) — the schema
// already lives on the primary (pushed there by `npm run db:push`), and
// db.ts's embedded-replica client pulls it down on connect instead. A
// Turso-less build stays exactly as before: fully local, first run creates
// its own schema from the embedded dump.
if (!process.env.TURSO_DB_URL) {
  const boot = new Database(process.env.DATABASE_PATH, { create: true });
  const hasTables = boot
    .query("select name from sqlite_master where type='table' and name='transactions'")
    .get();
  if (!hasTables) {
    boot.exec(schemaSql);
    const ins = boot.prepare(
      "insert or ignore into categories (name, spending_class, sort_order) values (?, ?, ?)",
    );
    for (const c of STARTER_CATEGORIES) ins.run(c.name, c.spendingClass, c.sortOrder);
    console.log("First run — ledger created with starter categories.");
  }
  boot.close();
}

// ——— App server (import AFTER env is settled so db.ts opens the right file) ———
const build = await import("../../build/server/index.js");
const handler = createRequestHandler(build);

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
};

function serveAsset(pathname: string): Response | null {
  const embedded = assetMap[pathname];
  if (!embedded) return null;
  const ext = path.extname(pathname).toLowerCase();
  const immutable = pathname.startsWith("/assets/");
  return new Response(Bun.file(embedded), {
    headers: {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    },
  });
}

function startServer(): { port: number; server: ReturnType<typeof Bun.serve> } {
  const preferred = Number(process.env.SPROUT_PORT ?? 4599);
  for (let port = preferred; port < preferred + 20; port++) {
    try {
      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);
          return serveAsset(url.pathname) ?? (await handler(req));
        },
      });
      return { port, server };
    } catch (err) {
      if (port === preferred + 19) throw err;
    }
  }
  throw new Error("unreachable");
}

const { port } = startServer();
const appUrl = `http://127.0.0.1:${port}`;
console.log(`Sprout Account — Household Ledger running at ${appUrl}`);
console.log(`Ledger file: ${process.env.DATABASE_PATH}`);

// ——— Open the window ———
// Chrome is launched via LaunchServices (`open -na`), NOT by spawning its
// executable directly: a directly-spawned Chrome inherits this app as its
// TCC "responsible process", so macOS pins Chrome's own file-access prompts
// (Downloads folder, etc.) on Sprout Account. Through `open`, Chrome runs
// under its own identity and its existing permissions.
const CHROME_APP = "/Applications/Google Chrome.app";

if (process.env.SPROUT_NO_WINDOW !== "1") {
  if (fs.existsSync(CHROME_APP)) {
    const profileDir = path.join(APP_DIR, "chrome-profile");
    Bun.spawn(
      [
        "open",
        "-na",
        "Google Chrome",
        "--args",
        `--app=${appUrl}`,
        `--user-data-dir=${profileDir}`,
        `--window-size=${WINDOW.width},${WINDOW.height}`,
        `--window-position=${WINDOW.x},${WINDOW.y}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
        "--disable-features=Translate",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    // No child handle through `open`, so close-to-quit works by watching for
    // the Chrome instance that owns our profile directory to disappear.
    let windowSeen = false;
    setInterval(() => {
      const alive =
        Bun.spawnSync(["pgrep", "-f", profileDir]).exitCode === 0;
      if (alive) windowSeen = true;
      else if (windowSeen) process.exit(0);
    }, 2000);
  } else {
    // No Chrome — plain browser tab fallback (app keeps running until Ctrl-C).
    Bun.spawn(["open", appUrl]);
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
