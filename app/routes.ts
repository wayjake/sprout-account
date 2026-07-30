import {
  type RouteConfig,
  index,
  layout,
  prefix,
  route,
} from "@react-router/dev/routes";

export default [
  layout("routes/shell.tsx", [
    index("routes/dashboard.tsx"),
    route("transactions", "routes/transactions.tsx"),
    route("transactions/:id", "routes/transaction-detail.tsx"),
    route("transfers", "routes/transfers.tsx"),
    ...prefix("import", [
      index("routes/import.tsx"),
      route("session/:sessionId", "routes/import-session.tsx"),
      route(":batchId/map", "routes/import-map.tsx"),
      route(":batchId", "routes/import-review.tsx"),
    ]),
    route("balances", "routes/balances.tsx"),
    route("categories", "routes/categories.tsx"),
    route("amazon", "routes/amazon.tsx"),
    route("backups", "routes/backups.tsx"),
    route("accounts", "routes/accounts.tsx"),
  ]),
  route("api/ai/categorize", "routes/api.ai-categorize.ts"),
] satisfies RouteConfig;
