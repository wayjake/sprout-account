# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Sprout Account — Household Ledger** — a local-only household finance manager (React Router + SQLite, no accounts, no cloud) dressed in 1999 desktop-software chrome. It imports bank/card statements, categorizes spending into base/living/luxury classes, tracks investment balances, and matches Amazon orders to card charges. It ships both as a dev web app and as a compiled macOS desktop app. See `README.md` for the user-facing feature tour.

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

`.env` knobs: `OPENROUTER_API_KEY`, `DATABASE_PATH` (default `./data/finance.db`), and **two** models — `OPENROUTER_MODEL` for categorization + CSV mapping, `OPENROUTER_MODEL_PDF` for statement extraction (a cheap model is fine for the first, not for the second).

To start over: delete `data/finance.db*`, then `npm run db:push && npm run seed`.

## Runtime constraints

- **Bun everywhere.** `app/.server/db.ts` imports `bun:sqlite`; a plain Node runtime cannot open the data layer. `vite.config.ts` marks `bun:sqlite` as SSR-external / optimizeDeps-excluded — keep it that way. `drizzle-kit` uses its own driver, so `db:push` is unaffected.
- **React Router v8, framework mode, SSR on.** Every new route or renamed route file must be registered in `app/routes.ts`.
- **`app/.server/` is server-only** by React Router convention — anything imported from a route module's `loader`/`action` and nothing else. Code shared with the browser (money parsing, CSV mapping preview, date math) lives in `app/lib/` and must stay isomorphic.
- Schema changes go through `npm run db:push`. The `drizzle/` migrations folder is configured but deliberately unused for now.
- `.agents/skills/react-router/` holds a vendored React Router skill with per-mode reference docs — read `references/framework-mode.md` (this app's mode) before guessing at router API behaviour.

## Data model invariants

`app/db/schema.ts` is the single source of truth; these rules are assumed everywhere downstream:

- **Money is integer cents, never floats.** Parse user/CSV/AI decimal strings with `parseCentsString` (`app/lib/money.ts`) — even AI PDF extraction returns amount *strings* for this reason.
- **Signs are household perspective**: spending negative, income positive; assets positive, debts negative. `isLiability` (`app/lib/accounts.ts`) is the single list of debt types — `credit_card`, `line_of_credit`, `mortgage`, `loan`. Never special-case `credit_card` directly; anything true of a card is true of the other three.
- **A positive amount on a debt is never income.** It is a payment or a credit coming off what is owed. `guardLiabilityCredit` (`app/.server/categorize.ts`) enforces this deterministically ahead of both the memory and the AI pass, because transfer matching can only catch it when the funding account's leg was imported too.
- **An account's `kind` is derived from its type, except for debts.** Loans ask: a line of credit usually has a statement worth importing row by row, a mortgage usually just a principal balance. `supportsKindChoice` / `resolveAccountKind` (`app/lib/accounts.ts`) own that rule, and `settings.accounts.ts` refuses to switch an account to balance-only while it still holds transactions.
- **Dates are ISO `YYYY-MM-DD` strings**, compared and sorted lexically; all date math goes through `app/lib/dates.ts` in UTC.
- `transactions.merchant` is the output of `normalizeMerchant` (`app/.server/categorize.ts`) — the key for merchant memory. Changing that function changes what matches historical memory, so re-key existing rows when you touch it. It is *not* a dedupe input: `computeTxnHashes` uses its own `normalizeDescription` (`app/.server/import/stage.ts`), so the two can change independently.
- Dedupe is per-account: `uniqueIndex(accountId, dedupeHash)`, where the hash is `date|amount|normalized description|occurrence-ordinal-within-file`.
- **Household-level only** — there is no per-person account/transaction concept, and it should not be reintroduced.

## Architecture

**Two upload flows, one pipeline.** CSV transaction exports and PDF statements answer different questions, so they have separate screens and never mix in one session. `import_sessions.purpose` (`import` / `reconcile`) records which flow a session belongs to, and both session review screens redirect to the other when the purpose doesn't match. Everything below the routes — batches, staged rows, commit, categorize — is shared.

- **`/import` — Transaction Import (CSV only).** Exports are the source of the register. A PDF here is refused with a pointer to `/reconcile`, and the whole upload is rejected rather than half of it, because a wrong file type is a mistake about which screen you're on.
- **`/reconcile` — Monthly Reconcile (PDF only).** A statement is not a source of transactions; it is the authority the ledger gets checked against. Its balances become anchors and its lines are matched against the books — only the unmatched ones are offered as rows to add.

**Import pipeline** (`app/.server/import/`) — the most intricate flow. One upload = one `import_session` containing N `import_batches`; nothing touches `transactions` until commit.

1. `intake.ts` has one entry point per flow — `intakeTransactions` (CSV) and `intakeStatement` (PDF) — sharing account resolution: guess from the filename, then let a statement's printed account number overrule it. Neither throws per-file (a bad file returns an error result and the rest proceed).
2. PDFs → `pdf.ts` (AI extraction of transactions *and* bracketing balances). CSVs → a per-account saved column mapping keyed by header signature (`mapping.ts`, AI-suggested once with a header-name heuristic fallback, then reused); unmapped CSVs stop at status `mapping` and wait for the user.
3. `stage.ts` writes `staged_rows` with a per-row status (`new` / `duplicate` / `possible_duplicate` / `excluded`), detects re-imports by file hash and overlapping statement periods, and can re-stage a batch against a different account (dedupe is account-relative, so everything is re-derived — including the ledger match, which is why `restageBatchAccount` looks the session purpose back up).
4. `commitBatch` inserts inside a single `db.transaction`, auto-categorizes from merchant memory, records balance snapshots, deletes the staged rows, and optionally auto-links transfers.
5. Commit redirects to `import/session/:id/categorize` — a confirm-or-fix pass over just-imported rows (`listImportedTransactions`, `queries.ts`), with suggested rows first and uncategorized ones below. Auto-linked transfer legs are excluded; they already carry a transfer category. Skipped when nothing was inserted, which is the usual outcome of a clean close. The commit counts ride along in the query string because they only exist in memory at that point — per-batch `statsJson` has no session-wide transfer count — so a revisit simply shows no banner.

Raw uploads are kept in `data/uploads/batch-<id>` between steps and deleted on commit/discard.

**The close** (`app/.server/reconcile.ts`, `routes/reconcile*.tsx`) inverts what staging means for a statement. `stageBatchRows({ matchLedger: true })` runs `buildStatementTransactionRows` instead of the import's dedupe: each line is matched one-to-one against rows already in that account on amount plus a date within `STATEMENT_MATCH_WINDOW_DAYS`, **never on description** — a statement prints "Coffee Shop" where the export said "SQ *COFFEE 1234". Matching runs in widening passes (exact date first, then a day out, then two) so a near miss can't steal the exact match belonging to another line, and a consumed ledger row is off the table, so two identical charges on one day need two ledger rows to both come back matched. A matched line stages as `duplicate` carrying `duplicateOfId`; an unmatched one stages as `new` and is the gap the close offers to fill. **A line whose only counterpart is the exact opposite amount is a sign conflict, not a gap** — an incoming transfer the extractor read as outgoing. It stages as `duplicate` with `signConflict`, because adding it would insert a second wrong-signed copy and throw the period off by *twice* the amount, and `diagnose` would then blame a double import that never happened. That pass runs only after every exact pass, so it can never take a row some line matches outright, and sign conflicts are counted separately from matched lines so a real disagreement can't hide inside an all-clear tally. The user can force a matched line in ("add anyway") or skip a missing one — both are just the existing include/exclude toggle. `ReconcilePanel` on the close screen runs `pendingRowsForBatches` through `reconcileAccounts`, so the preview is the arithmetic of the commit that hasn't happened yet.

**Categorization** (`app/.server/categorize.ts`) is layered, and the layering is the point: the deterministic `guardLiabilityCredit` rule first, then merchant memory (free, no network), then AI for what's left, in batches, with a confidence floor. `categorySource` (`user` / `memory` / `ai` / `auto`) records which layer won — `auto` is the rule pass. The guard also *vetoes*: when memory or the AI proposes an income category for a credit on a debt account, the row is left uncategorized (counted as `blocked`) rather than mis-filed, and the AI's answer never reaches merchant memory. `recordUserChoice` overwrites anything; `recordAiChoice` never overwrites a `user`-sourced memory row.

**The bulk run is client-driven** (`components/categorize-run.tsx` → `api/ai/categorize`). The endpoint answers `intent=plan` with the id list for the whole run and `intent=run` with one chunk's stats, and the client posts one chunk (`AI_BATCH_SIZE`, so one AI call) per fetcher submission. Each submission revalidates the page's loaders, so rows fill in as they are decided instead of after a single minutes-long request, and the chunk boundary is where Cancel takes effect — the chunk in flight is already paid for and still finishes. **The client owns the id list** because the layers deliberately leave rows uncategorized (low confidence, guard-blocked): a server-side "next N uncategorized" loop would hand back the same rows forever.

**Balances** (`app/.server/balances.ts`) are derived, not stored: latest anchor (`balance_snapshots`) + transaction activity since it. With no anchor the figure is a *change* in balance, flagged `unanchored`. `reconcileAccounts` compares statement anchors against recorded activity and produces named, most-specific-first explanations for gaps. `pendingRowsForBatches` feeds not-yet-committed rows through the same maths so both the import and close screens preview the outcome.

**Cleared state is derived too.** `transactions` has no reconciled column. `clearedWindows` returns each transaction-kind account's checked periods and `clearedStateFor` places a row in one: `reconciled` inside a period that ties out, `mismatch` inside one that doesn't, `open` outside every period (before the first anchor or after the last). This means editing a row correctly un-reconciles its whole period instead of leaving a stale flag. The window maths is duplicated from `reconcileAccounts` — same `(previous anchor, this anchor]` span, same `expected = from + activity`, same zero-diff test — because the register calls it on every page load and can't afford to read whole transactions; **if you change one, change both**, or a row will claim to be reconciled while the account screen says the period is off. The `?reconciled=yes|no` filter compiles the same windows into a SQL predicate rather than filtering the page, since filtering after pagination would return short pages and a cursor that skips rows.

Balance-only accounts reconcile on a different axis, and the distinction matters: they have no ledger to check a statement against, so their windows measure consecutive snapshots against the *contributions* pointed at them via `transferAccountId` (sign-flipped into that account's perspective). Whatever the contributions don't explain is market return on an asset, or accrued interest on a debt — reported as window status `movement` with a plain-language `note`, never as a `mismatch`, and a balance account's overall status therefore stays `ok`. This is what lets a $1,600 mortgage payment show up as $400 principal and $1,200 interest without the loan needing a ledger of its own.

**Transfers** (`app/.server/transfers.ts`) pair opposite-amount legs across accounts within `TRANSFER_WINDOW_DAYS`, greedy one-to-one by date proximity. Only mutually-unambiguous, transfer-looking pairs auto-link; the rest are suggestions. Linked legs get a transfer-class category so they drop out of income/spend reporting — `Credit Card Payment` when a card is involved, `Loan Payment` for other debts, else `Transfer` (`paymentCategoryName`). Dismissals persist in `transfer_rejections`.

On a transaction-tracked debt the payment splits in two: the principal leg links away as `Loan Payment` (transfer class, out of reporting) and the posted interest charge stands on its own as `Interest` (base class) — that separation is why both starter categories exist, and why interest is the only part of the payment that counts as spending.

**A balance-only account never produces an opposite row**, so pairing is structurally impossible there — `rawCandidatePairs` joins transactions to transactions. Those legs instead name the far *account*: `transactions.transferAccountId` (mutually exclusive with `transferPeerId`), set by `linkTransferToAccount`, which refuses any target that is not an active balance-kind account. The leg gets a transfer-class category through the same `transferCategoryId` path as a pair, so it leaves income/spend reporting and stops showing up in `unmatchedTransferLegs`. Both link kinds count toward `transferVolume`.

Because the far side is an account rather than a row, deleting or re-kinding that account has to be blocked while legs point at it — `settings.accounts.ts` guards both directions (it already refused balance-only for an account holding transactions; it now also refuses transaction-kind for one that is somebody's named far side).

**Amazon** (`app/.server/amazon.ts`) matches orders to charges in three passes: exact 1:1, split shipments (one order, ≤4 charges), combined charges (≤3 orders, one charge); ambiguity goes to review. `applyItemSplits` pro-rates tax/shipping with largest-remainder rounding so splits sum exactly to the transaction.

**AI calls** all go through `chatJSON` (`app/.server/openrouter.ts`): OpenRouter, strict JSON-schema response format derived from a zod schema, one validation retry. Every feature must degrade gracefully without `OPENROUTER_API_KEY` — PDF import is the only hard dependency.

**Backups** (`app/.server/backups.ts`) use `VACUUM INTO` for online snapshots into `data/backups/<timestamp>__<label>.db`. Restore/clear swap the file underneath the app via `withDbClosed` in `db.ts` — `db` is an intentionally mutable live binding, so always import `{ db }` rather than caching the ORM instance.

**Desktop** (`scripts/desktop/`, `src-tauri/`) — `build.ts` generates an embedded asset manifest, dumps the schema to `schema.generated.sql`, `bun build --compile`s `server.ts` to a single arm64 binary, and copies it as a Tauri sidecar. `server.ts` bootstraps schema + starter categories on first run and deliberately **ignores `DATABASE_PATH`** (Bun auto-loads stray `.env` files) in favor of `~/Library/Application Support/Sprout Account/`; override with `SPROUT_DB_PATH`. The green titlebar in `routes/shell.tsx` *is* the native window frame — drag/zoom/minimize/close are wired to Tauri.

## UI conventions

- The retro look lives in `app/app.css` as utility classes: `bevel-out`, `bevel-btn`, `bevel-in`, `field-inset`, `groove`, `titlebar`. Compose these rather than inventing new shadow stacks. Colors come from the Tailwind v4 `@theme` block (`--color-class-*`, `--color-chrome`, `--color-ledger`).
- Spending-class colors are CVD-validated and duplicated deliberately in `app/components/ui.tsx` (badges) and `app/components/charts.tsx` (`CHART_CLASS_COLORS`); keep them in sync.
- Charts are hand-rolled SVG in `app/components/charts.tsx` — there is no charting library, and adding one would fight the theme.
- UI copy is plain accounting language — accounts, transactions, categories, balances, income, expenses, transfers, backups. The retro *look* stays (Company Navigator, LCD tiles, status bar); the fantasy/adventure vocabulary was removed deliberately, so don't reintroduce quests, gold, hauls, or hoards. `routes/shell.tsx` holds the toolbar labels.
- Routes are classic loader/action modules with form posts and an `intent` field — no client-side data fetching layer.
- **Settings panes are URL state, not paths.** `?pane=accounts` (`app/lib/panes.ts`) opens a modal window over the current screen; the pathless layout `routes/settings-pane.tsx` wraps every screen, loads the pane's data, and renders `PaneWindow` beside its `<Outlet />` so the screen underneath keeps its state and scroll. `PaneWindow` is a native `<dialog>` — focus trap, inert background and focus restoration come from the platform, and Escape/✕ only *navigate*, letting the URL close the window. A pathless layout has no URL to post to, so pane writes live in their own action-only route (`routes/settings.accounts.ts`) that fetchers target by path.
- The menu bar (`app/components/menubar.tsx`, contents in `routes/shell.tsx`) follows the ARIA menubar pattern. Menu entries that lead nowhere are declared `unavailable` — greyed and `aria-disabled`, not omitted.
- Drizzle renders columns interpolated into `sql` templates **unqualified**, so a correlated subquery like ``sql`(select count(*) from ${transactions} where ${transactions.accountId} = ${accounts.id})` `` silently compares the inner table to itself and returns 0. Use grouped queries and join in JS instead.
