# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Sprout Account 2000** — a local-only household finance manager (React Router + SQLite, no accounts, no cloud) dressed in 1999 desktop-software chrome. It imports bank/card statements, categorizes spending into base/living/luxury classes, tracks investment balances, and matches Amazon orders to card charges. It ships both as a dev web app and as a compiled macOS desktop app. See `README.md` for the user-facing feature tour.

## Commands

```sh
npm run dev              # dev server (Bun-driven; user usually has this running already)
npm run typecheck        # react-router typegen && tsc — the only automated check in the repo
npm run db:push          # sync app/db/schema.ts → SQLite (use this, not migrations)
npm run db:studio        # browse the database
npm run seed             # idempotent starter categories
npm run seed -- --fake 12000   # + generated fake transactions for pagination/perf work
npm run build            # react-router build
npm run desktop:build    # web build → Bun binary → Tauri .app/.dmg (needs rustup + sqlite3)
```

There is no test suite and no linter. `npm run typecheck` is the verification step; it runs `react-router typegen` first, so route type errors after adding a route usually just mean typegen hasn't run.

To start over: delete `data/finance.db*`, then `npm run db:push && npm run seed`.

## Runtime constraints

- **Bun everywhere.** `app/.server/db.ts` imports `bun:sqlite`; a plain Node runtime cannot open the data layer. `vite.config.ts` marks `bun:sqlite` as SSR-external / optimizeDeps-excluded — keep it that way. `drizzle-kit` uses its own driver, so `db:push` is unaffected.
- **React Router v8, framework mode, SSR on.** Every new route or renamed route file must be registered in `app/routes.ts`.
- **`app/.server/` is server-only** by React Router convention — anything imported from a route module's `loader`/`action` and nothing else. Code shared with the browser (money parsing, CSV mapping preview, date math) lives in `app/lib/` and must stay isomorphic.
- Schema changes go through `npm run db:push`. The `drizzle/` migrations folder is configured but deliberately unused for now.

## Data model invariants

`app/db/schema.ts` is the single source of truth; these rules are assumed everywhere downstream:

- **Money is integer cents, never floats.** Parse user/CSV/AI decimal strings with `parseCentsString` (`app/lib/money.ts`) — even AI PDF extraction returns amount *strings* for this reason.
- **Signs are household perspective**: spending negative, income positive; assets positive, liabilities (credit cards) negative (`isLiability` in `app/.server/balances.ts`).
- **Dates are ISO `YYYY-MM-DD` strings**, compared and sorted lexically; all date math goes through `app/lib/dates.ts` in UTC.
- `transactions.merchant` is the output of `normalizeMerchant` (`app/.server/categorize.ts`) — the key for merchant memory. Changing that function changes what matches historical memory, so re-key existing rows when you touch it. It is *not* a dedupe input: `computeTxnHashes` uses its own `normalizeDescription` (`app/.server/import/stage.ts`), so the two can change independently.
- Dedupe is per-account: `uniqueIndex(accountId, dedupeHash)`, where the hash is `date|amount|normalized description|occurrence-ordinal-within-file`.
- **Household-level only** — there is no per-person account/transaction concept, and it should not be reintroduced.

## Architecture

**Import pipeline** (`app/.server/import/`) — the most intricate flow. One upload = one `import_session` containing N `import_batches`; nothing touches `transactions` until commit.

1. `intake.ts` routes each file: guesses the account from the filename, then lets a PDF's printed account number overrule it; never throws per-file (a bad file returns an error result and the rest proceed).
2. PDFs → `pdf.ts` (AI extraction of transactions *and* bracketing balances). CSVs → a per-account saved column mapping keyed by header signature (`mapping.ts`, AI-suggested once with a header-name heuristic fallback, then reused); unmapped CSVs stop at status `mapping` and wait for the user.
3. `stage.ts` writes `staged_rows` with a per-row status (`new` / `duplicate` / `possible_duplicate` / `excluded`), detects re-imports by file hash and overlapping statement periods, and can re-stage a batch against a different account (dedupe is account-relative, so everything is re-derived).
4. `commitBatch` inserts inside a single `db.transaction`, auto-categorizes from merchant memory, records balance snapshots, deletes the staged rows, and optionally auto-links transfers.

Raw uploads are kept in `data/uploads/batch-<id>` between steps and deleted on commit/discard.

**Categorization** (`app/.server/categorize.ts`) is layered, and the layering is the point: merchant memory first (free, no network), AI only for what's left, in batches, with a confidence floor. `categorySource` records which layer won. `recordUserChoice` overwrites anything; `recordAiChoice` never overwrites a `user`-sourced memory row.

**Balances** (`app/.server/balances.ts`) are derived, not stored: latest anchor (`balance_snapshots`) + transaction activity since it. With no anchor the figure is a *change* in balance, flagged `unanchored`. `reconcileAccounts` compares statement anchors against recorded activity and produces named, most-specific-first explanations for gaps. `pendingRowsForBatches` feeds not-yet-committed rows through the same maths so the import screen previews the outcome.

**Transfers** (`app/.server/transfers.ts`) pair opposite-amount legs across accounts within `TRANSFER_WINDOW_DAYS`, greedy one-to-one by date proximity. Only mutually-unambiguous, transfer-looking pairs auto-link; the rest are suggestions. Linked legs get a transfer-class category so they drop out of income/spend reporting. Dismissals persist in `transfer_rejections`.

**Amazon** (`app/.server/amazon.ts`) matches orders to charges in three passes: exact 1:1, split shipments (one order, ≤4 charges), combined charges (≤3 orders, one charge); ambiguity goes to review. `applyItemSplits` pro-rates tax/shipping with largest-remainder rounding so splits sum exactly to the transaction.

**AI calls** all go through `chatJSON` (`app/.server/openrouter.ts`): OpenRouter, strict JSON-schema response format derived from a zod schema, one validation retry. Every feature must degrade gracefully without `OPENROUTER_API_KEY` — PDF import is the only hard dependency.

**Backups** (`app/.server/backups.ts`) use `VACUUM INTO` for online snapshots into `data/backups/<timestamp>__<label>.db`. Restore/clear swap the file underneath the app via `withDbClosed` in `db.ts` — `db` is an intentionally mutable live binding, so always import `{ db }` rather than caching the ORM instance.

**Desktop** (`scripts/desktop/`, `src-tauri/`) — `build.ts` generates an embedded asset manifest, dumps the schema to `schema.generated.sql`, `bun build --compile`s `server.ts` to a single arm64 binary, and copies it as a Tauri sidecar. `server.ts` bootstraps schema + starter categories on first run and deliberately **ignores `DATABASE_PATH`** (Bun auto-loads stray `.env` files) in favor of `~/Library/Application Support/Sprout Account/`; override with `SPROUT_DB_PATH`. The green titlebar in `routes/shell.tsx` *is* the native window frame — drag/zoom/minimize/close are wired to Tauri.

## UI conventions

- The retro look lives in `app/app.css` as utility classes: `bevel-out`, `bevel-btn`, `bevel-in`, `field-inset`, `groove`, `titlebar`. Compose these rather than inventing new shadow stacks. Colors come from the Tailwind v4 `@theme` block (`--color-class-*`, `--color-chrome`, `--color-ledger`).
- Spending-class colors are CVD-validated and duplicated deliberately in `app/components/ui.tsx` (badges) and `app/components/charts.tsx` (`CHART_CLASS_COLORS`); keep them in sync.
- Charts are hand-rolled SVG in `app/components/charts.tsx` — there is no charting library, and adding one would fight the theme.
- The app has a voice (Company Navigator, status bar with opinions, "The Endless Bazaar"). New screens should match it; `routes/shell.tsx` holds the toolbar labels.
- Routes are classic loader/action modules with form posts and an `intent` field — no client-side data fetching layer.
