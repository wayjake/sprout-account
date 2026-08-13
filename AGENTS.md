# Repository Guidelines

## Project Structure & Module Organization

Sprout Account is a local household finance app built with React Router, Drizzle, SQLite/libSQL, and Tauri. App code lives in `app/`: route modules are in `app/routes/`, shared browser-safe helpers in `app/lib/`, UI components in `app/components/`, and database schema/seeds in `app/db/`. Server-only logic follows the React Router convention under `app/.server/`. Desktop packaging lives in `scripts/desktop/` and `src-tauri/`. Local runtime data, uploads, and backups belong under `data/`; do not commit generated database files.

## Build, Test, and Development Commands

- `npm run dev`: start the Bun-powered React Router dev server.
- `npm run build`: create the production web build.
- `npm run start`: serve `./build/server/index.js` after a build.
- `npm run typecheck`: run React Router type generation and `tsc`; this is the main automated verification step.
- `npm run db:push`: sync `app/db/schema.ts` to the local database.
- `npm run db:studio`: inspect the database with Drizzle Studio.
- `npm run seed`: insert starter categories; add `-- --fake 12000` for generated test data.
- `npm run test:extraction`: run statement extraction checks against `scripts/fixtures/`.
- `npm run desktop:build`: build the web app, Bun sidecar, and Tauri desktop bundle.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and ES modules. Prefer existing route/action/loader patterns and register new routes in `app/routes.ts`. Keep shared code isomorphic unless it belongs in `app/.server/`. Use integer cents for money, ISO `YYYY-MM-DD` date strings, and existing helpers such as `app/lib/money.ts` and `app/lib/dates.ts`. UI should reuse established retro utility classes from `app/app.css` instead of new visual systems.

## Testing Guidelines

There is no broad unit test suite or linter. Run `npm run typecheck` before handing off code. For import or PDF extraction changes, run `npm run test:extraction`. Its fixtures live in `scripts/fixtures/` but are gitignored and absent from a fresh clone — they are real statements holding real personal data, and this repository is public. Never commit a statement PDF. Use fake seeded data for pagination, dashboard, and performance-oriented UI checks.

## Commit & Pull Request Guidelines

Recent commits use concise, descriptive sentence-case summaries, for example `Monthly Reconcile: match PDF statements against the ledger`. Keep commits focused on one behavior change. Pull requests should describe the user-visible change, note database/schema implications, list verification commands run, and include screenshots for UI changes.

## Security & Configuration Tips

Configuration comes from `.env`. `OPENROUTER_API_KEY` enables PDF extraction and AI-assisted categorization; without it, core CSV and ledger workflows should still degrade gracefully. Keep local databases, uploads, backups, and API keys out of version control.
