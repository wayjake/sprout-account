# Sprout Account 🌱 — Household Ledger

A local-only household finance manager wearing its Sunday-best 1999 desktop-software
chrome: beveled buttons, gradient title bars, a Company Navigator, LCD readouts, and
a status bar with opinions. Import bank/card statements (CSV or PDF), track
investment balances, categorize spending into **base / living / luxury** classes,
and match Amazon orders to card charges — all stored in a local SQLite file, no
accounts, no cloud.

## Setup

Requires [Bun](https://bun.sh) — the data layer imports `bun:sqlite`, so a plain
Node runtime cannot open the database.

```sh
git clone git@github.com:wayjake/sprout-account.git
cd sprout-account
npm install
cp .env.example .env    # then add your OpenRouter API key
npm run db:push        # create/update data/finance.db
npm run seed           # starter categories
npm run dev
```

`.env`:

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Enables PDF extraction, CSV mapping suggestions, and AI categorization |
| `OPENROUTER_MODEL` | Model for categorization + CSV column mapping (default `openai/gpt-4o-mini`) |
| `OPENROUTER_MODEL_PDF` | Model for PDF statement extraction (default `google/gemini-2.5-flash`) |
| `DATABASE_PATH` | SQLite file location (default `./data/finance.db`) |

Without an API key everything still works except PDF import; CSV mapping falls
back to a header-name heuristic and categorization uses merchant memory only.

## How it works

- **Accounts** (Settings) are either *transaction* accounts (checking, savings,
  credit cards — import individual transactions) or *balance* accounts
  (investment/retirement — import balance snapshots).
- **Import** stages everything for review before committing. CSVs get a saved
  per-account column mapping (AI-suggested the first time, reused afterwards);
  PDFs are extracted by the AI. Re-imports and overlapping statements are
  detected by a per-account dedupe hash and pre-excluded; same-date/same-amount
  rows with drifted descriptions are flagged as *possible duplicates* for you to
  decide. Commits are atomic.
- **Categorization** is three layers: your manual choices are remembered per
  merchant (merchant memory), repeat merchants auto-categorize free at import
  time, and the *AI categorize* button (Transactions page) sends only the
  still-unknown ones to OpenRouter. Your corrections always outrank AI memory.
  Filing happens by opening a transaction — a type-to-search category box, a
  *Suggest a category* button for the AI's opinion on that one row, and
  Previous / Next to walk the filtered register without closing the window.
  Committing an import drops you straight into that list, filtered to the
  account, dates, and still-uncategorized rows it just added.
- **Spending classes**: every category is *base* (mortgage, utilities —
  the fixed foundation), *living* (groceries, gas — day-to-day needs),
  *luxury* (restaurants, shopping — discretionary), *income*, or *transfer*
  (income/transfer stay out of spending reports). The dashboard contrasts the
  three spend classes per month.
- **Amazon matching**: request your order history export (Amazon →
  Account → Request Your Data → Your Orders), upload the CSV, and the matcher pairs
  orders with card charges — exact matches, split shipments (one order, several
  charges), and combined charges (several orders, one charge). Ambiguous cases go
  to a review list. On a matched transaction you can categorize individual items
  and *apply items as splits* (tax/shipping pro-rated to the cent).
- **Backups & restore**: one-click snapshots of the SQLite file into
  `data/backups/` (named `timestamp__label.db`), restore any of them (your current
  data is auto-stashed as `pre-restore` first), load external `.db` files, and a
  type-to-confirm **Clear database** that starts you fresh with starter categories
  (auto-stashed as `pre-reset`).
- **Categorization rules, on their own**: save your categories and merchant rules
  to a small `.json` file, separate from the ledger they came out of. Clear the
  database, then load the file back and the app still knows that SQ \*COFFEE is
  Restaurants — you start fresh on accounts without teaching it everything again.
  Loading merges by name: categories are only added (an existing one keeps its own
  spending class, nothing is deleted), and your own choices beat the file's when
  both have an opinion. Replace mode clears merchant rules first if you'd rather
  the file be the whole list.

## Desktop app (macOS arm64)

```sh
npm run desktop:build
# → src-tauri/target/release/bundle/macos/Sprout Account.app (+ .dmg)
```

Three stages: the web app is built, compiled into a single Bun executable
(server + embedded assets + schema bootstrap), then wrapped by **Tauri** as a
sidecar inside a **frameless native window** — the retro green titlebar IS the
window frame: drag it to move, double-click to zoom, and the –/□/✕ buttons
drive real minimize/maximize/quit. The teal "desktop" backdrop only appears in
a browser; the desktop app fills the window edge-to-edge.

The desktop app keeps its own ledger in
`~/Library/Application Support/Sprout Account/` — separate from this repo's dev
database. Requires the Rust toolchain (`rustup`) for building. The standalone
server binary also lands at `dist/sprout-account` (`SPROUT_PORT`,
`SPROUT_DB_PATH`, `SPROUT_NO_WINDOW=1` env knobs).

**Note:** the app runs on Bun everywhere (`bun:sqlite` under Drizzle) — use
`bun run dev` / the npm scripts as written; a plain Node runtime can no longer
open the database layer. `drizzle-kit` still uses its own driver, so
`npm run db:push` works as before.

## Useful commands

```sh
npm run db:push          # sync schema changes to the SQLite file
npm run db:studio        # browse the database
npm run seed             # idempotent starter categories
npm run seed -- --fake 12000   # + fake data for testing
npm run typecheck
```

To start over: delete `data/finance.db*`, then `npm run db:push && npm run seed`.
