import {
  type RouteConfig,
  index,
  layout,
  prefix,
  route,
} from "@react-router/dev/routes";

export default [
  layout("routes/shell.tsx", [
    // Pathless layout: hosts the `?pane=` modal windows over every screen,
    // which keeps the screen underneath mounted while a pane is open.
    layout("routes/settings-pane.tsx", [
      index("routes/dashboard.tsx"),
      // The detail screen is a child of the register, not a page of its own:
      // it opens as a modal over the list, which keeps the register's filters,
      // scroll and pagination alive underneath. The cost is that the register's
      // loader runs for every `/transactions/:id` hit, including deep links
      // from other screens — one page of rows and a count.
      route("transactions", "routes/transactions.tsx", [
        route(":id", "routes/transaction-detail.tsx"),
      ]),
      route("transfers", "routes/transfers.tsx"),
      // Transaction exports (.csv) come in here…
      ...prefix("import", [
        index("routes/import.tsx"),
        route("session/:sessionId", "routes/import-session.tsx"),
        // …a whole folder of statements comes in here, unattended…
        ...prefix("bulk", [
          index("routes/bulk-import.tsx"),
          route(":sessionId", "routes/bulk-run.tsx"),
        ]),
        route(":batchId/map", "routes/import-map.tsx"),
        route(":batchId", "routes/import-review.tsx"),
      ]),
      // …and statements (.pdf) are closed against the books here.
      ...prefix("reconcile", [
        index("routes/reconcile.tsx"),
        route(":sessionId", "routes/reconcile-session.tsx"),
      ]),
      route("balances", "routes/balances.tsx"),
      route("categories", "routes/categories.tsx"),
      route("amazon", "routes/amazon.tsx"),
      route("backups", "routes/backups.tsx"),
    ]),
  ]),
  // Pane writes, and the redirect from the old Accounts page.
  route("settings/accounts", "routes/settings.accounts.ts"),
  route("accounts", "routes/accounts.ts"),
  route("api/ai/categorize", "routes/api.ai-categorize.ts"),
  // Categorization rules download — the response is the file, so it can't be
  // a loader on the Backups screen (that loader feeds the page).
  route("api/rules/export", "routes/api.rules-export.ts"),
  // Bulk edits from the register's selection. Action-only, and outside the
  // layouts above so a submission doesn't run the shell and pane loaders.
  route("api/transactions/bulk", "routes/api.transactions-bulk.ts"),
  // The bulk import driver — one step per POST, posted to dozens of times in a
  // row, so it stays outside the layouts too.
  route("api/bulk/step", "routes/api.bulk-step.ts"),
] satisfies RouteConfig;
