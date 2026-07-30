import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const SPENDING_CLASSES = [
  "base",
  "living",
  "luxury",
  "income",
  "transfer",
] as const;
export type SpendingClass = (typeof SPENDING_CLASSES)[number];

export const ACCOUNT_KINDS = ["transaction", "balance"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit_card",
  "investment",
  "retirement",
  "other",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

const createdAt = () =>
  integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`);

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  institution: text("institution").notNull(),
  kind: text("kind", { enum: ACCOUNT_KINDS }).notNull(),
  accountType: text("account_type", { enum: ACCOUNT_TYPES }).notNull(),
  lastFour: text("last_four"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  spendingClass: text("spending_class", { enum: SPENDING_CLASSES }).notNull(),
  isArchived: integer("is_archived", { mode: "boolean" })
    .notNull()
    .default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

export const CATEGORY_SOURCES = ["user", "memory", "ai", "auto"] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    /** ISO YYYY-MM-DD */
    date: text("date").notNull(),
    /** Signed cents, household perspective: spend negative, income positive */
    amountCents: integer("amount_cents").notNull(),
    /** Raw description from the statement */
    description: text("description").notNull(),
    /** Normalized merchant (see categorize.normalizeMerchant) */
    merchant: text("merchant").notNull(),
    categoryId: integer("category_id").references(() => categories.id),
    categorySource: text("category_source", { enum: CATEGORY_SOURCES }),
    /** The opposite leg when this row is one side of an internal transfer */
    transferPeerId: integer("transfer_peer_id").references(
      (): AnySQLiteColumn => transactions.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    importBatchId: integer("import_batch_id").references(
      () => importBatches.id,
    ),
    dedupeHash: text("dedupe_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("txn_account_dedupe_idx").on(t.accountId, t.dedupeHash),
    index("txn_date_id_idx").on(t.date, t.id),
    index("txn_account_date_idx").on(t.accountId, t.date),
    index("txn_category_idx").on(t.categoryId),
    index("txn_merchant_idx").on(t.merchant),
    index("txn_transfer_peer_idx").on(t.transferPeerId),
  ],
);

/** Dismissed transfer suggestions, so they never resurface. txnAId < txnBId. */
export const transferRejections = sqliteTable(
  "transfer_rejections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txnAId: integer("txn_a_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    txnBId: integer("txn_b_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("transfer_reject_pair_idx").on(t.txnAId, t.txnBId)],
);

export const transactionSplits = sqliteTable(
  "transaction_splits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    amountCents: integer("amount_cents").notNull(),
    memo: text("memo"),
  },
  (t) => [index("split_transaction_idx").on(t.transactionId)],
);

/**
 * A known balance for an account on a date — the anchor points the running
 * balance is derived from. Sign is always household perspective: assets
 * positive, liabilities (credit cards) negative.
 */
export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    date: text("date").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    source: text("source", { enum: ["import", "manual"] }).notNull(),
    note: text("note"),
    importBatchId: integer("import_batch_id").references(
      () => importBatches.id,
    ),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("balance_account_date_idx").on(t.accountId, t.date)],
);

/**
 * "statement" is a mixed file — transactions plus the closing balance, which is
 * what a bank or card PDF actually contains.
 */
export const BATCH_KINDS = [
  "transactions",
  "balances",
  "statement",
  "amazon_orders",
] as const;
export const BATCH_STATUSES = [
  "mapping",
  "review",
  "committed",
  "discarded",
] as const;

/** One upload of N files. Batches under it are reviewed and committed together. */
export const importSessions = sqliteTable("import_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status", { enum: ["open", "committed", "discarded"] })
    .notNull()
    .default("open"),
  /** Files in the upload that could not be read at all, and why */
  notesJson: text("notes_json"),
  createdAt: createdAt(),
  committedAt: integer("committed_at"),
});

export const importBatches = sqliteTable("import_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").references(() => importSessions.id),
  accountId: integer("account_id").references(() => accounts.id),
  /**
   * Account description as it read at import time ("Chase · Checking ··1234").
   * Snapshotted so history stays readable after a rename, and so account-less
   * batches (Amazon orders) still say where they came from.
   */
  accountLabel: text("account_label"),
  kind: text("kind", { enum: BATCH_KINDS }).notNull(),
  sourceType: text("source_type", { enum: ["pdf", "csv"] }).notNull(),
  filename: text("filename").notNull(),
  fileHash: text("file_hash").notNull(),
  status: text("status", { enum: BATCH_STATUSES }).notNull(),
  /** Date range of the rows detected in this file (ISO YYYY-MM-DD) */
  periodStart: text("period_start"),
  periodEnd: text("period_end"),
  /** Rows detected in the file (how many were written lives in statsJson) */
  rowCount: integer("row_count"),
  statsJson: text("stats_json"),
  createdAt: createdAt(),
  committedAt: integer("committed_at"),
});

export const STAGED_STATUSES = [
  "new",
  "duplicate",
  "possible_duplicate",
  "excluded",
] as const;
export type StagedStatus = (typeof STAGED_STATUSES)[number];

export const ROW_KINDS = ["transaction", "balance"] as const;
export type RowKind = (typeof ROW_KINDS)[number];

export const stagedRows = sqliteTable(
  "staged_rows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    batchId: integer("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    /** One batch can stage both — a statement carries transactions and a balance. */
    rowKind: text("row_kind", { enum: ROW_KINDS }).notNull().default("transaction"),
    rowIndex: integer("row_index").notNull(),
    /** Normalized: {date, description, merchant, amountCents} or {date, balanceCents} */
    dataJson: text("data_json").notNull(),
    dedupeHash: text("dedupe_hash").notNull(),
    status: text("status", { enum: STAGED_STATUSES }).notNull(),
    duplicateOfId: integer("duplicate_of_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    /**
     * Another file in the same upload already covers this row. Kept apart from
     * `status` — which records whether the row is already in the ledger — so
     * overlap can be recomputed when files are added, reassigned or dropped
     * without trampling that or a manual exclude.
     */
    supersededByBatchId: integer("superseded_by_batch_id").references(
      (): AnySQLiteColumn => importBatches.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [index("staged_batch_idx").on(t.batchId)],
);

export const csvMappings = sqliteTable(
  "csv_mappings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Lowercased headers joined with "|" */
    headerSignature: text("header_signature").notNull(),
    mappingJson: text("mapping_json").notNull(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [
    uniqueIndex("mapping_account_signature_idx").on(
      t.accountId,
      t.headerSignature,
    ),
  ],
);

export const merchantMemory = sqliteTable("merchant_memory", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  normalizedMerchant: text("normalized_merchant").notNull().unique(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id),
  source: text("source", { enum: ["user", "ai"] }).notNull(),
  useCount: integer("use_count").notNull().default(1),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const amazonOrders = sqliteTable("amazon_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Amazon's order ID, e.g. 113-1234567-1234567 */
  orderId: text("order_id").notNull().unique(),
  orderDate: text("order_date").notNull(),
  totalCents: integer("total_cents").notNull(),
  importBatchId: integer("import_batch_id").references(() => importBatches.id),
  createdAt: createdAt(),
});

export const amazonOrderItems = sqliteTable(
  "amazon_order_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id")
      .notNull()
      .references(() => amazonOrders.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    totalCents: integer("total_cents").notNull(),
    asin: text("asin"),
    categoryId: integer("category_id").references(() => categories.id),
  },
  (t) => [index("amazon_item_order_idx").on(t.orderId)],
);

export const MATCH_STATUSES = ["confirmed", "suggested", "rejected"] as const;

export const amazonMatches = sqliteTable(
  "amazon_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    orderId: integer("order_id")
      .notNull()
      .references(() => amazonOrders.id, { onDelete: "cascade" }),
    /** Portion of this transaction attributed to this order */
    amountCents: integer("amount_cents").notNull(),
    matchType: text("match_type", { enum: ["auto", "manual"] }).notNull(),
    status: text("status", { enum: MATCH_STATUSES }).notNull(),
    confidence: real("confidence"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("amazon_match_txn_order_idx").on(t.transactionId, t.orderId),
  ],
);

export const accountsRelations = relations(accounts, ({ many }) => ({
  transactions: many(transactions),
  balanceSnapshots: many(balanceSnapshots),
  csvMappings: many(csvMappings),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  transactions: many(transactions),
  splits: many(transactionSplits),
  merchantMemory: many(merchantMemory),
}));

export const transactionsRelations = relations(
  transactions,
  ({ one, many }) => ({
    account: one(accounts, {
      fields: [transactions.accountId],
      references: [accounts.id],
    }),
    category: one(categories, {
      fields: [transactions.categoryId],
      references: [categories.id],
    }),
    importBatch: one(importBatches, {
      fields: [transactions.importBatchId],
      references: [importBatches.id],
    }),
    transferPeer: one(transactions, {
      fields: [transactions.transferPeerId],
      references: [transactions.id],
      relationName: "transferPeer",
    }),
    splits: many(transactionSplits),
    amazonMatches: many(amazonMatches),
  }),
);

export const transactionSplitsRelations = relations(
  transactionSplits,
  ({ one }) => ({
    transaction: one(transactions, {
      fields: [transactionSplits.transactionId],
      references: [transactions.id],
    }),
    category: one(categories, {
      fields: [transactionSplits.categoryId],
      references: [categories.id],
    }),
  }),
);

export const balanceSnapshotsRelations = relations(
  balanceSnapshots,
  ({ one }) => ({
    account: one(accounts, {
      fields: [balanceSnapshots.accountId],
      references: [accounts.id],
    }),
  }),
);

export const importSessionsRelations = relations(importSessions, ({ many }) => ({
  batches: many(importBatches),
}));

export const importBatchesRelations = relations(
  importBatches,
  ({ one, many }) => ({
    session: one(importSessions, {
      fields: [importBatches.sessionId],
      references: [importSessions.id],
    }),
    account: one(accounts, {
      fields: [importBatches.accountId],
      references: [accounts.id],
    }),
    stagedRows: many(stagedRows),
    transactions: many(transactions),
  }),
);

export const stagedRowsRelations = relations(stagedRows, ({ one }) => ({
  batch: one(importBatches, {
    fields: [stagedRows.batchId],
    references: [importBatches.id],
  }),
  duplicateOf: one(transactions, {
    fields: [stagedRows.duplicateOfId],
    references: [transactions.id],
  }),
}));

export const csvMappingsRelations = relations(csvMappings, ({ one }) => ({
  account: one(accounts, {
    fields: [csvMappings.accountId],
    references: [accounts.id],
  }),
}));

export const merchantMemoryRelations = relations(merchantMemory, ({ one }) => ({
  category: one(categories, {
    fields: [merchantMemory.categoryId],
    references: [categories.id],
  }),
}));

export const amazonOrdersRelations = relations(
  amazonOrders,
  ({ one, many }) => ({
    items: many(amazonOrderItems),
    matches: many(amazonMatches),
    importBatch: one(importBatches, {
      fields: [amazonOrders.importBatchId],
      references: [importBatches.id],
    }),
  }),
);

export const amazonOrderItemsRelations = relations(
  amazonOrderItems,
  ({ one }) => ({
    order: one(amazonOrders, {
      fields: [amazonOrderItems.orderId],
      references: [amazonOrders.id],
    }),
    category: one(categories, {
      fields: [amazonOrderItems.categoryId],
      references: [categories.id],
    }),
  }),
);

export const amazonMatchesRelations = relations(amazonMatches, ({ one }) => ({
  transaction: one(transactions, {
    fields: [amazonMatches.transactionId],
    references: [transactions.id],
  }),
  order: one(amazonOrders, {
    fields: [amazonMatches.orderId],
    references: [amazonOrders.id],
  }),
}));

export type Account = typeof accounts.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type TransactionSplit = typeof transactionSplits.$inferSelect;
export type BalanceSnapshot = typeof balanceSnapshots.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type ImportSession = typeof importSessions.$inferSelect;
export type StagedRow = typeof stagedRows.$inferSelect;
export type CsvMapping = typeof csvMappings.$inferSelect;
export type MerchantMemoryRow = typeof merchantMemory.$inferSelect;
export type AmazonOrder = typeof amazonOrders.$inferSelect;
export type AmazonOrderItem = typeof amazonOrderItems.$inferSelect;
export type AmazonMatch = typeof amazonMatches.$inferSelect;
export type TransferRejection = typeof transferRejections.$inferSelect;
