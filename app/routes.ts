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
      route("transactions", "routes/transactions.tsx"),
      route("transactions/:id", "routes/transaction-detail.tsx"),
      route("transfers", "routes/transfers.tsx"),
      // Transaction exports (.csv) come in here…
      ...prefix("import", [
        index("routes/import.tsx"),
        route("session/:sessionId", "routes/import-session.tsx"),
        route("session/:sessionId/categorize", "routes/import-session-categorize.tsx"),
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
] satisfies RouteConfig;
