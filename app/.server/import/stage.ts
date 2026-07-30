import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { loadMemory, lookupMemory, normalizeMerchant } from "~/.server/categorize";
import { autoLinkTransfers } from "~/.server/transfers";
import type { PendingRows } from "~/.server/balances";
import { accountLabel } from "~/lib/accounts";
import type { NormalizedBalanceRow, NormalizedTxnRow } from "~/lib/csv-mapping";

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

// --- raw upload retention between import steps (deleted on commit/discard) ---

const UPLOADS_DIR = path.join(
  path.dirname(process.env.DATABASE_PATH ?? "./data/finance.db"),
  "uploads",
);

export function saveUpload(batchId: number, buffer: Buffer) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, `batch-${batchId}`), buffer);
}

export function readUpload(batchId: number): Buffer | null {
  try {
    return fs.readFileSync(path.join(UPLOADS_DIR, `batch-${batchId}`));
  } catch {
    return null;
  }
}

export function deleteUpload(batchId: number) {
  fs.rmSync(path.join(UPLOADS_DIR, `batch-${batchId}`), { force: true });
}

// --- staging ---

export interface StagedTxnData {
  date: string;
  description: string;
  merchant: string;
  amountCents: number;
}

export interface StagedBalanceData {
  date: string;
  balanceCents: number;
  /** "opening" / "closing" when it came off a statement */
  kind?: string;
}

function normalizeDescription(desc: string): string {
  return desc.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Dedupe hash: date|amount|normalized description|occurrence ordinal within
 * the file — the ordinal distinguishes two genuinely identical purchases on
 * one statement while keeping re-imports of the same statement idempotent.
 */
type TxnRowInput = NormalizedTxnRow & { rowIndex?: number };
type BalanceRowInput = NormalizedBalanceRow & { rowIndex?: number; kind?: string };

export function computeTxnHashes(rows: NormalizedTxnRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = `${r.date}|${r.amountCents}|${normalizeDescription(r.description)}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return sha256(`${key}|${ordinal}`);
  });
}

export async function createSession() {
  const [session] = await db.insert(schema.importSessions).values({}).returning();
  return session;
}

export async function createBatch(input: {
  sessionId?: number | null;
  accountId: number | null;
  accountLabel: string;
  kind: (typeof schema.BATCH_KINDS)[number];
  sourceType: "pdf" | "csv";
  filename: string;
  fileHash: string;
  status: (typeof schema.BATCH_STATUSES)[number];
  periodStart?: string;
  periodEnd?: string;
  rowCount?: number;
  statsJson?: string;
}) {
  const [batch] = await db.insert(schema.importBatches).values(input).returning();
  return batch;
}

/** Has this exact file already been imported (committed) before? */
export async function findPriorCommit(fileHash: string, excludeBatchId?: number) {
  const rows = await db
    .select({ id: schema.importBatches.id, filename: schema.importBatches.filename })
    .from(schema.importBatches)
    .where(
      and(
        eq(schema.importBatches.fileHash, fileHash),
        eq(schema.importBatches.status, "committed"),
      ),
    );
  return rows.find((r) => r.id !== excludeBatchId) ?? null;
}

export interface OverlappingBatch {
  id: number;
  filename: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * Earlier committed imports for this account whose detected date range overlaps
 * the given one — a different file covering ground we've already ingested
 * (statement re-download, overlapping export windows). Row-level dedupe still
 * catches the individual duplicates; this is the heads-up before that.
 */
export async function findOverlappingBatches(input: {
  accountId: number;
  periodStart: string;
  periodEnd: string;
  excludeBatchId?: number;
}): Promise<OverlappingBatch[]> {
  const rows = await db
    .select({
      id: schema.importBatches.id,
      filename: schema.importBatches.filename,
      periodStart: schema.importBatches.periodStart,
      periodEnd: schema.importBatches.periodEnd,
    })
    .from(schema.importBatches)
    .where(
      and(
        eq(schema.importBatches.accountId, input.accountId),
        eq(schema.importBatches.status, "committed"),
        // Ranges overlap when each starts on or before the other one ends.
        lte(schema.importBatches.periodStart, input.periodEnd),
        gte(schema.importBatches.periodEnd, input.periodStart),
      ),
    )
    .orderBy(schema.importBatches.periodStart);
  return rows.filter(
    (r): r is OverlappingBatch =>
      r.id !== input.excludeBatchId && r.periodStart != null && r.periodEnd != null,
  );
}

/**
 * Stamp the batch with what the file turned out to contain: how many rows were
 * detected and the date range they cover. Kept on the batch itself so the
 * import history still reads correctly after staged rows are cleared on commit.
 */
async function recordDetectedRange(batchId: number, dates: string[]) {
  const sorted = dates.filter(Boolean).sort();
  await db
    .update(schema.importBatches)
    .set({
      periodStart: sorted[0] ?? null,
      periodEnd: sorted[sorted.length - 1] ?? null,
      rowCount: dates.length,
    })
    .where(eq(schema.importBatches.id, batchId));
}

async function buildTransactionRows(
  batchId: number,
  accountId: number,
  rows: TxnRowInput[],
) {
  const hashes = computeTxnHashes(rows);

  const existingByHash = new Map<string, number>();
  if (hashes.length > 0) {
    const existing = await db
      .select({
        id: schema.transactions.id,
        dedupeHash: schema.transactions.dedupeHash,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, accountId),
          inArray(schema.transactions.dedupeHash, hashes),
        ),
      );
    for (const e of existing) existingByHash.set(e.dedupeHash, e.id);
  }

  // Soft duplicates: same account, date, and amount but different description
  // (pending→posted drift, CSV vs PDF renderings).
  const softKeys =
    rows.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({
                date: schema.transactions.date,
                amountCents: schema.transactions.amountCents,
              })
              .from(schema.transactions)
              .where(
                and(
                  eq(schema.transactions.accountId, accountId),
                  inArray(
                    schema.transactions.date,
                    [...new Set(rows.map((r) => r.date))],
                  ),
                ),
              )
          ).map((r) => `${r.date}|${r.amountCents}`),
        );

  return rows.map((r, i) => {
    const hash = hashes[i];
    const exactDupId = existingByHash.get(hash);
    const status: (typeof schema.STAGED_STATUSES)[number] = exactDupId
      ? "duplicate"
      : softKeys.has(`${r.date}|${r.amountCents}`)
        ? "possible_duplicate"
        : "new";
    const data: StagedTxnData = {
      date: r.date,
      description: r.description,
      merchant: normalizeMerchant(r.description),
      amountCents: r.amountCents,
    };
    return {
      batchId,
      rowKind: "transaction" as const,
      rowIndex: r.rowIndex ?? i,
      dataJson: JSON.stringify(data),
      dedupeHash: hash,
      status,
      duplicateOfId: exactDupId ?? null,
    };
  });
}

async function buildBalanceRows(
  batchId: number,
  accountId: number,
  rows: BalanceRowInput[],
) {
  const existing = await db
    .select()
    .from(schema.balanceSnapshots)
    .where(eq(schema.balanceSnapshots.accountId, accountId));
  const byDate = new Map(existing.map((e) => [e.date, e.balanceCents]));

  return rows.map((r, i) => {
    const prior = byDate.get(r.date);
    const status: (typeof schema.STAGED_STATUSES)[number] =
      prior == null
        ? "new"
        : prior === r.balanceCents
          ? "duplicate"
          : "possible_duplicate"; // same date, different balance → will overwrite
    const data: StagedBalanceData = {
      date: r.date,
      balanceCents: r.balanceCents,
      kind: r.kind,
    };
    return {
      batchId,
      rowKind: "balance" as const,
      rowIndex: r.rowIndex ?? i,
      dataJson: JSON.stringify(data),
      dedupeHash: sha256(`${r.date}|${r.balanceCents}`),
      status,
      duplicateOfId: null,
    };
  });
}

export interface StageCounts {
  total: number;
  duplicates: number;
  possibleDuplicates: number;
}

function countStatuses(rows: { status: string }[]): StageCounts {
  return {
    total: rows.length,
    duplicates: rows.filter((s) => s.status === "duplicate").length,
    possibleDuplicates: rows.filter((s) => s.status === "possible_duplicate").length,
  };
}

/**
 * Stage a file's contents. One batch may carry both kinds — a statement PDF
 * yields transactions and the closing balance that checks them.
 */
export async function stageBatchRows(
  batchId: number,
  accountId: number,
  input: { txns?: TxnRowInput[]; balances?: BalanceRowInput[] },
) {
  const txns = input.txns ?? [];
  const balances = input.balances ?? [];
  const txnRows = await buildTransactionRows(batchId, accountId, txns);
  const balanceRows = await buildBalanceRows(batchId, accountId, balances);
  const staged = [...txnRows, ...balanceRows];

  const CHUNK = 200;
  for (let i = 0; i < staged.length; i += CHUNK) {
    await db.insert(schema.stagedRows).values(staged.slice(i, i + CHUNK));
  }
  await recordDetectedRange(batchId, [
    ...txns.map((r) => r.date),
    ...balances.map((r) => r.date),
  ]);
  return {
    txns: countStatuses(txnRows),
    balances: countStatuses(balanceRows),
  };
}

/**
 * Move a staged batch to a different account. Dedupe status is relative to the
 * account, so everything is re-derived against the new one; row-level
 * include/exclude choices are reset because they were made against other books.
 */
export async function restageBatchAccount(batchId: number, newAccountId: number) {
  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, batchId),
  });
  if (!batch) throw new Error("Batch not found");
  if (batch.status !== "review" && batch.status !== "mapping") {
    throw new Error("Only a batch still under review can be reassigned");
  }
  const account = await db.query.accounts.findFirst({
    where: eq(schema.accounts.id, newAccountId),
  });
  if (!account) throw new Error("Account not found");

  const existing = await db
    .select()
    .from(schema.stagedRows)
    .where(eq(schema.stagedRows.batchId, batchId))
    .orderBy(asc(schema.stagedRows.rowIndex));

  const txns: TxnRowInput[] = [];
  const balances: BalanceRowInput[] = [];
  for (const row of existing) {
    if (row.rowKind === "balance") {
      const d = JSON.parse(row.dataJson) as StagedBalanceData;
      balances.push({ ...d, rowIndex: row.rowIndex });
    } else {
      const d = JSON.parse(row.dataJson) as StagedTxnData;
      txns.push({
        date: d.date,
        description: d.description,
        amountCents: d.amountCents,
        rowIndex: row.rowIndex,
      });
    }
  }

  await db.delete(schema.stagedRows).where(eq(schema.stagedRows.batchId, batchId));
  await db
    .update(schema.importBatches)
    .set({ accountId: newAccountId, accountLabel: accountLabel(account) })
    .where(eq(schema.importBatches.id, batchId));
  if (existing.length > 0) {
    await stageBatchRows(batchId, newAccountId, { txns, balances });
  }
}

// --- overlap between files in one upload ---

/**
 * Which file should own a transaction when two cover the same ground. A CSV
 * export is structured data straight from the bank; a PDF is whatever the
 * extractor could read off a rendered page, so the CSV wins. Otherwise the
 * file uploaded first wins, which keeps the result stable.
 */
function ownershipRank(batch: { sourceType: string; id: number }): [number, number] {
  return [batch.sourceType === "csv" ? 0 : 1, batch.id];
}

/**
 * Rows are matched on date + amount + how-many-times-seen, never description:
 * the same purchase reads "SQ *COFFEE 1234" in a CSV and "Coffee Shop" off a
 * PDF, so a text match would miss every one of them.
 */
function overlapKeys(rows: { date: string; amountCents: number }[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${r.amountCents}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    return `${base}|${ordinal}`;
  });
}

export interface OverlapSummary {
  batchId: number;
  /** Rows this file gives up, by the batch that keeps them */
  supersededBy: { batchId: number; filename: string; count: number }[];
}

/**
 * Work out, per account, which pending file owns each transaction, and mark the
 * losing copies. Safe to re-run: it recomputes from scratch every time, so
 * dropping or reassigning a file hands its rows back to whoever is left.
 */
export async function dedupeSessionBatches(sessionId: number): Promise<OverlapSummary[]> {
  const batches = await db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.sessionId, sessionId));

  const pending = batches.filter(
    (b) => b.status === "review" || b.status === "mapping",
  );
  const pendingIds = pending.map((b) => b.id);
  if (pendingIds.length === 0) return [];

  // Start clean so a dropped file releases its claim
  await db
    .update(schema.stagedRows)
    .set({ supersededByBatchId: null })
    .where(inArray(schema.stagedRows.batchId, pendingIds));

  const rows = await db
    .select()
    .from(schema.stagedRows)
    .where(
      and(
        inArray(schema.stagedRows.batchId, pendingIds),
        eq(schema.stagedRows.rowKind, "transaction"),
      ),
    )
    .orderBy(asc(schema.stagedRows.batchId), asc(schema.stagedRows.rowIndex));

  const byBatch = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!byBatch.has(r.batchId)) byBatch.set(r.batchId, []);
    byBatch.get(r.batchId)!.push(r);
  }

  const summaries = new Map<number, Map<number, number>>();
  const byAccount = new Map<number, typeof pending>();
  for (const b of pending) {
    if (b.accountId == null) continue;
    if (!byAccount.has(b.accountId)) byAccount.set(b.accountId, []);
    byAccount.get(b.accountId)!.push(b);
  }

  const losers: { id: number; winner: number }[] = [];

  for (const group of byAccount.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => {
      const [ra, ia] = ownershipRank(a);
      const [rb, ib] = ownershipRank(b);
      return ra - rb || ia - ib;
    });

    const claimed = new Map<string, number>();
    for (const batch of ordered) {
      const batchRows = byBatch.get(batch.id) ?? [];
      const parsed = batchRows.map(
        (r) => JSON.parse(r.dataJson) as StagedTxnData,
      );
      const keys = overlapKeys(parsed);
      batchRows.forEach((row, i) => {
        const owner = claimed.get(keys[i]);
        if (owner == null) {
          claimed.set(keys[i], batch.id);
          return;
        }
        losers.push({ id: row.id, winner: owner });
        const perBatch = summaries.get(batch.id) ?? new Map<number, number>();
        perBatch.set(owner, (perBatch.get(owner) ?? 0) + 1);
        summaries.set(batch.id, perBatch);
      });
    }
  }

  // Group the writes by winning batch so this is a handful of statements
  const byWinner = new Map<number, number[]>();
  for (const l of losers) {
    if (!byWinner.has(l.winner)) byWinner.set(l.winner, []);
    byWinner.get(l.winner)!.push(l.id);
  }
  for (const [winner, ids] of byWinner) {
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      await db
        .update(schema.stagedRows)
        .set({ supersededByBatchId: winner })
        .where(inArray(schema.stagedRows.id, ids.slice(i, i + CHUNK)));
    }
  }

  const filenames = new Map(batches.map((b) => [b.id, b.filename]));
  return [...summaries.entries()].map(([batchId, perBatch]) => ({
    batchId,
    supersededBy: [...perBatch.entries()].map(([id, count]) => ({
      batchId: id,
      filename: filenames.get(id) ?? `#${id}`,
      count,
    })),
  }));
}

// --- reconciliation input ---

/**
 * The rows a set of batches would write if committed now, shaped for the
 * reconciliation engine so the import screen can show the outcome first.
 */
export async function pendingRowsForBatches(batchIds: number[]): Promise<PendingRows> {
  if (batchIds.length === 0) return { txns: [], balances: [] };

  const rows = await db
    .select({
      accountId: schema.importBatches.accountId,
      rowKind: schema.stagedRows.rowKind,
      dataJson: schema.stagedRows.dataJson,
    })
    .from(schema.stagedRows)
    .innerJoin(
      schema.importBatches,
      eq(schema.stagedRows.batchId, schema.importBatches.id),
    )
    .where(
      and(
        inArray(schema.stagedRows.batchId, batchIds),
        inArray(schema.stagedRows.status, ["new", "possible_duplicate"]),
        // another file in this upload is providing the row
        isNull(schema.stagedRows.supersededByBatchId),
      ),
    );

  const pending: PendingRows = { txns: [], balances: [] };
  for (const r of rows) {
    if (r.accountId == null) continue;
    if (r.rowKind === "balance") {
      const d = JSON.parse(r.dataJson) as StagedBalanceData;
      pending.balances.push({
        accountId: r.accountId,
        date: d.date,
        balanceCents: d.balanceCents,
      });
    } else {
      const d = JSON.parse(r.dataJson) as StagedTxnData;
      pending.txns.push({
        accountId: r.accountId,
        date: d.date,
        amountCents: d.amountCents,
        description: d.description,
      });
    }
  }
  return pending;
}

// --- commit / discard ---

export interface CommitStats {
  inserted: number;
  balancesRecorded: number;
  skipped: number;
  autoCategorized: number;
  transfersLinked: number;
}

const emptyStats = (): CommitStats => ({
  inserted: 0,
  balancesRecorded: 0,
  skipped: 0,
  autoCategorized: 0,
  transfersLinked: 0,
});

/**
 * Commit a reviewed batch atomically: insert included rows, record balances,
 * and auto-categorize from merchant memory.
 */
export async function commitBatch(
  batchId: number,
  opts: { linkTransfers?: boolean } = {},
): Promise<CommitStats> {
  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, batchId),
  });
  if (!batch || batch.status !== "review") {
    throw new Error("Batch is not in review state");
  }
  if (!batch.accountId) throw new Error("Batch has no account");
  const account = await db.query.accounts.findFirst({
    where: eq(schema.accounts.id, batch.accountId),
  });
  if (!account) throw new Error("Account not found");

  const included = await db
    .select()
    .from(schema.stagedRows)
    .where(
      and(
        eq(schema.stagedRows.batchId, batchId),
        inArray(schema.stagedRows.status, ["new", "possible_duplicate"]),
        isNull(schema.stagedRows.supersededByBatchId),
      ),
    );

  const memory = await loadMemory();
  const stats = emptyStats();

  db.transaction((tx) => {
    for (const row of included) {
      if (row.rowKind === "balance") {
        const data = JSON.parse(row.dataJson) as StagedBalanceData;
        tx.insert(schema.balanceSnapshots)
          .values({
            accountId: account.id,
            date: data.date,
            balanceCents: data.balanceCents,
            source: "import",
            importBatchId: batchId,
          })
          .onConflictDoUpdate({
            target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
            set: { balanceCents: data.balanceCents, source: "import", importBatchId: batchId },
          })
          .run();
        stats.balancesRecorded++;
        continue;
      }

      const data = JSON.parse(row.dataJson) as StagedTxnData;
      const memoryHit = lookupMemory(data.merchant, memory);
      const inserted = tx
        .insert(schema.transactions)
        .values({
          accountId: account.id,
          date: data.date,
          amountCents: data.amountCents,
          description: data.description,
          merchant: data.merchant,
          categoryId: memoryHit?.categoryId ?? null,
          categorySource: memoryHit ? "memory" : null,
          importBatchId: batchId,
          dedupeHash: row.dedupeHash,
        })
        .onConflictDoNothing()
        .returning({ id: schema.transactions.id })
        .all();
      if (inserted.length > 0) {
        stats.inserted++;
        if (memoryHit) stats.autoCategorized++;
      } else {
        stats.skipped++;
      }
    }

    // Staged rows have served their purpose once committed
    tx.delete(schema.stagedRows)
      .where(eq(schema.stagedRows.batchId, batchId))
      .run();
    const priorStats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
    tx.update(schema.importBatches)
      .set({
        status: "committed",
        committedAt: sql`(unixepoch())`,
        statsJson: JSON.stringify({ ...priorStats, ...stats }),
      })
      .where(eq(schema.importBatches.id, batchId))
      .run();
  });

  // Pair up internal transfers now that both legs may exist. Runs after the
  // insert transaction; failures here must not roll back the committed rows.
  // A session commit defers this until every file is in.
  if (opts.linkTransfers !== false && stats.inserted > 0) {
    stats.transfersLinked = await autoLinkTransfers();
    if (stats.transfersLinked > 0) {
      const prior = batch.statsJson ? JSON.parse(batch.statsJson) : {};
      await db
        .update(schema.importBatches)
        .set({ statsJson: JSON.stringify({ ...prior, ...stats }) })
        .where(eq(schema.importBatches.id, batchId));
    }
  }

  deleteUpload(batchId);
  return stats;
}

export interface SessionCommitResult {
  stats: CommitStats;
  committedBatchIds: number[];
  /** Batches that could not be committed yet, with why */
  blocked: { id: number; filename: string; reason: string }[];
}

/**
 * Commit every reviewed batch in a session, then link transfers once at the
 * end — a transfer's two legs often arrive in two different files of the same
 * upload, and pairing them per-file would miss them.
 */
export async function commitSession(sessionId: number): Promise<SessionCommitResult> {
  const batches = await db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.sessionId, sessionId))
    .orderBy(asc(schema.importBatches.id));

  const stats = emptyStats();
  const committedBatchIds: number[] = [];
  const blocked: SessionCommitResult["blocked"] = [];

  for (const batch of batches) {
    if (batch.status === "committed" || batch.status === "discarded") continue;
    if (batch.status === "mapping") {
      blocked.push({
        id: batch.id,
        filename: batch.filename,
        reason: "still needs its columns mapped",
      });
      continue;
    }
    if (!batch.accountId) {
      blocked.push({
        id: batch.id,
        filename: batch.filename,
        reason: "has no account assigned",
      });
      continue;
    }
    const s = await commitBatch(batch.id, { linkTransfers: false });
    stats.inserted += s.inserted;
    stats.balancesRecorded += s.balancesRecorded;
    stats.skipped += s.skipped;
    stats.autoCategorized += s.autoCategorized;
    committedBatchIds.push(batch.id);
  }

  if (stats.inserted > 0) {
    stats.transfersLinked = await autoLinkTransfers();
  }

  if (blocked.length === 0) {
    await db
      .update(schema.importSessions)
      .set({ status: "committed", committedAt: sql`(unixepoch())` })
      .where(eq(schema.importSessions.id, sessionId));
  }

  return { stats, committedBatchIds, blocked };
}

export async function discardBatch(batchId: number) {
  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, batchId),
  });
  await db
    .update(schema.importBatches)
    .set({ status: "discarded" })
    .where(eq(schema.importBatches.id, batchId));
  await db.delete(schema.stagedRows).where(eq(schema.stagedRows.batchId, batchId));
  deleteUpload(batchId);
  // Rows this file was claiming go back to whichever file is left
  if (batch?.sessionId) await dedupeSessionBatches(batch.sessionId);
}

export async function discardSession(sessionId: number) {
  const batches = await db
    .select({ id: schema.importBatches.id, status: schema.importBatches.status })
    .from(schema.importBatches)
    .where(eq(schema.importBatches.sessionId, sessionId));
  for (const b of batches) {
    if (b.status === "committed") continue;
    await discardBatch(b.id);
  }
  await db
    .update(schema.importSessions)
    .set({ status: "discarded" })
    .where(eq(schema.importSessions.id, sessionId));
}
