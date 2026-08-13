import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import {
  guardLiabilityCredit,
  loadMemory,
  lookupMemory,
  normalizeMerchant,
} from "~/.server/categorize";
import { autoLinkAccountTransfers, autoLinkTransfers } from "~/.server/transfers";
import type { PendingRows } from "~/.server/balances";
import { accountLabel } from "~/lib/accounts";
import { addDays, daysBetween } from "~/lib/dates";
import type { NormalizedBalanceRow, NormalizedTxnRow } from "~/lib/csv-mapping";

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

// --- raw upload retention between import steps (deleted on commit/discard) ---

const UPLOADS_DIR = path.join(
  path.dirname(process.env.DATABASE_PATH ?? "./data/finance.db"),
  "uploads",
);

/**
 * Which queue a retained upload belongs to. A bulk run holds its statements
 * before any batch exists to name them by — the file is uploaded, then read
 * back a step later — so it needs a key of its own.
 */
export type UploadOwner = "batch" | "bulk";

const uploadPath = (id: number, owner: UploadOwner = "batch") =>
  path.join(UPLOADS_DIR, `${owner}-${id}`);

export function saveUpload(id: number, buffer: Buffer, owner: UploadOwner = "batch") {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(uploadPath(id, owner), buffer);
}

export function readUpload(id: number, owner: UploadOwner = "batch"): Buffer | null {
  try {
    return fs.readFileSync(uploadPath(id, owner));
  } catch {
    return null;
  }
}

export function deleteUpload(id: number, owner: UploadOwner = "batch") {
  fs.rmSync(uploadPath(id, owner), { force: true });
}

// --- staging ---

export interface StagedTxnData {
  date: string;
  description: string;
  merchant: string;
  amountCents: number;
  /**
   * The date the statement printed, when `date` was clamped into the statement
   * period. Persisted so a re-stage against another account still matches the
   * ledger on what the statement said rather than on where the row was filed.
   */
  matchDate?: string;
  /** Set on a statement row that a close found already in the books */
  matchedDate?: string;
  matchedDescription?: string;
  /**
   * The books hold this transaction with the opposite sign. Almost always the
   * extractor read the direction backwards off the PDF; adding the row would
   * double-count it, so it is never offered as a gap to fill.
   */
  signConflict?: boolean;
  /** The ledger row's amount, when it disagrees with the statement's */
  matchedAmountCents?: number;
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
type TxnRowInput = NormalizedTxnRow & {
  rowIndex?: number;
  /**
   * The date the source actually printed, when `date` has been moved off it —
   * a statement clamped into its own period (`extractFromPdf`). The ledger is
   * matched on this, so moving a row never costs it its counterpart.
   */
  matchDate?: string;
};
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

export async function createSession(purpose: schema.SessionPurpose = "import") {
  const [session] = await db
    .insert(schema.importSessions)
    .values({ purpose })
    .returning();
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

/**
 * How far a statement line may sit from the ledger row it is the same
 * transaction as. A card statement prints the posting date; a CSV export often
 * carries the transaction date, and the two drift by a day or three.
 */
export const STATEMENT_MATCH_WINDOW_DAYS = 3;

interface LedgerCandidate {
  id: number;
  date: string;
  amountCents: number;
  description: string;
  normalized: string;
}

/**
 * Statement rows, matched against what the books already hold rather than
 * deduped against them. The question a month-end close asks is not "is this row
 * new?" but "did my ledger already know about it?" — a statement line and its
 * CSV twin rarely share a description ("SQ *COFFEE 1234" vs "Coffee Shop"), so
 * the match is on amount and near-date only.
 *
 * Matched rows are staged `duplicate` and point at the ledger row they found;
 * unmatched ones are staged `new`, and those are the gaps the close offers to
 * fill. Matching is one-to-one and consumes its candidate, so two identical
 * $5 charges on one day need two ledger rows to both come back matched.
 */
async function buildStatementTransactionRows(
  batchId: number,
  accountId: number,
  rows: TxnRowInput[],
) {
  const hashes = computeTxnHashes(rows);
  if (rows.length === 0) return [];

  // Match on what the statement printed, not on where the row was filed — see
  // `matchDate`. Staging still records the filed date; only the search moves.
  const matchDateOf = (r: TxnRowInput) => r.matchDate ?? r.date;

  const dates = rows.map(matchDateOf).sort();
  const ledger = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      description: schema.transactions.description,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, accountId),
        gte(schema.transactions.date, addDays(dates[0], -STATEMENT_MATCH_WINDOW_DAYS)),
        lte(
          schema.transactions.date,
          addDays(dates[dates.length - 1], STATEMENT_MATCH_WINDOW_DAYS),
        ),
      ),
    );

  const byAmount = new Map<number, LedgerCandidate[]>();
  for (const t of ledger) {
    if (!byAmount.has(t.amountCents)) byAmount.set(t.amountCents, []);
    byAmount.get(t.amountCents)!.push({
      id: t.id,
      date: t.date,
      amountCents: t.amountCents,
      description: t.description,
      normalized: normalizeDescription(t.description),
    });
  }

  // Widening passes: every row that can be explained by a same-day ledger entry
  // is settled before any row is allowed to reach across a day, so a near miss
  // never steals the exact match belonging to another line.
  const matched = new Map<number, LedgerCandidate>();
  const taken = new Set<number>();
  for (let slack = 0; slack <= STATEMENT_MATCH_WINDOW_DAYS; slack++) {
    rows.forEach((row, i) => {
      if (matched.has(i)) return;
      const normalized = normalizeDescription(row.description);
      const printed = matchDateOf(row);
      const candidate = (byAmount.get(row.amountCents) ?? [])
        .filter(
          (c) => !taken.has(c.id) && Math.abs(daysBetween(c.date, printed)) <= slack,
        )
        // Same wording is the surest sign of the same transaction; after that,
        // the nearest date, then the oldest row, so the result never wobbles.
        .sort(
          (a, b) =>
            Number(b.normalized === normalized) - Number(a.normalized === normalized) ||
            Math.abs(daysBetween(a.date, printed)) -
              Math.abs(daysBetween(b.date, printed)) ||
            a.id - b.id,
        )[0];
      if (!candidate) return;
      matched.set(i, candidate);
      taken.add(candidate.id);
    });
  }

  // Last resort, and only for lines nothing matched: a ledger row of the exact
  // opposite amount is the same transaction with its direction reversed — an
  // incoming transfer the extractor read as outgoing. Offering it as a gap to
  // fill would insert a second, wrong-signed copy and throw the period off by
  // twice the amount, so it is reported as a conflict instead. This runs only
  // after every exact pass, so it can never take a row that a line matches
  // outright.
  const signConflicts = new Map<number, LedgerCandidate>();
  rows.forEach((row, i) => {
    if (matched.has(i)) return;
    const printed = matchDateOf(row);
    const candidate = (byAmount.get(-row.amountCents) ?? [])
      .filter(
        (c) =>
          !taken.has(c.id) &&
          Math.abs(daysBetween(c.date, printed)) <= STATEMENT_MATCH_WINDOW_DAYS,
      )
      .sort(
        (a, b) =>
          Math.abs(daysBetween(a.date, printed)) -
            Math.abs(daysBetween(b.date, printed)) || a.id - b.id,
      )[0];
    if (!candidate || candidate.amountCents === 0) return;
    signConflicts.set(i, candidate);
    taken.add(candidate.id);
  });

  return rows.map((r, i) => {
    const hit = matched.get(i);
    const flipped = signConflicts.get(i);
    const found = hit ?? flipped;
    const data: StagedTxnData = {
      date: r.date,
      description: r.description,
      merchant: normalizeMerchant(r.description),
      amountCents: r.amountCents,
      matchDate: r.matchDate,
      matchedDate: found?.date,
      matchedDescription: found?.description,
      signConflict: flipped ? true : undefined,
      matchedAmountCents: flipped?.amountCents,
    };
    return {
      batchId,
      rowKind: "transaction" as const,
      rowIndex: r.rowIndex ?? i,
      dataJson: JSON.stringify(data),
      dedupeHash: hashes[i],
      status: (found ? "duplicate" : "new") as (typeof schema.STAGED_STATUSES)[number],
      duplicateOfId: found?.id ?? null,
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
 *
 * `matchLedger` switches transaction rows from import dedupe to the month-end
 * close's ledger match; see `buildStatementTransactionRows`.
 */
export async function stageBatchRows(
  batchId: number,
  accountId: number,
  input: {
    txns?: TxnRowInput[];
    balances?: BalanceRowInput[];
    matchLedger?: boolean;
  },
) {
  const txns = input.txns ?? [];
  const balances = input.balances ?? [];
  const txnRows = input.matchLedger
    ? await buildStatementTransactionRows(batchId, accountId, txns)
    : await buildTransactionRows(batchId, accountId, txns);
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
        matchDate: d.matchDate,
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
    await stageBatchRows(batchId, newAccountId, {
      txns,
      balances,
      // Ledger matching is relative to the account too, so a statement moved to
      // a different account has to be re-matched the way it was staged.
      matchLedger: await isReconcileBatch(batch),
    });
  }
}

/** Does this batch belong to a month-end close rather than a CSV import? */
async function isReconcileBatch(batch: { sessionId: number | null }) {
  if (batch.sessionId == null) return false;
  const session = await db.query.importSessions.findFirst({
    where: eq(schema.importSessions.id, batch.sessionId),
  });
  return session?.purpose === "reconcile";
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
  /** Legs pointed at a balance-only account, which never have a second leg. */
  accountsLinked: number;
}

const emptyStats = (): CommitStats => ({
  inserted: 0,
  balancesRecorded: 0,
  skipped: 0,
  autoCategorized: 0,
  transfersLinked: 0,
  accountsLinked: 0,
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
  const allCategories = await db.select().from(schema.categories);
  const stats = emptyStats();

  const balances: (typeof schema.balanceSnapshots.$inferInsert)[] = [];
  const transactions: (typeof schema.transactions.$inferInsert)[] = [];
  for (const row of included) {
    if (row.rowKind === "balance") {
      const data = JSON.parse(row.dataJson) as StagedBalanceData;
      balances.push({
        accountId: account.id,
        date: data.date,
        balanceCents: data.balanceCents,
        source: "import",
        importBatchId: batchId,
      });
      continue;
    }

    const data = JSON.parse(row.dataJson) as StagedTxnData;
    const memoryHit = lookupMemory(data.merchant, memory);
    // A credit on a card is a payment or a refund, never income — force or
    // withhold the category regardless of what memory suggests.
    const guarded = guardLiabilityCredit(
      data,
      account.accountType,
      memoryHit?.categoryId ?? null,
      allCategories,
    );
    const categoryId = guarded === undefined ? (memoryHit?.categoryId ?? null) : guarded;
    const categorySource: schema.CategorySource | null =
      categoryId == null ? null : guarded === undefined ? "memory" : "auto";
    transactions.push({
      accountId: account.id,
      date: data.date,
      amountCents: data.amountCents,
      description: data.description,
      merchant: data.merchant,
      categoryId,
      categorySource,
      importBatchId: batchId,
      dedupeHash: row.dedupeHash,
    });
  }

  await db.transaction(async (tx) => {
    // Turso-backed writes cross the network even when reads use the embedded
    // replica. Keep each statement atomic, but send bounded multi-row writes
    // instead of awaiting one remote statement for every ledger row.
    const CHUNK = 100;
    for (let i = 0; i < balances.length; i += CHUNK) {
      const chunk = balances.slice(i, i + CHUNK);
      await tx
        .insert(schema.balanceSnapshots)
        .values(chunk)
        .onConflictDoUpdate({
          target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
          set: {
            balanceCents: sql`excluded.balance_cents`,
            source: "import",
            importBatchId: batchId,
          },
        })
        .run();
      stats.balancesRecorded += chunk.length;
    }

    for (let i = 0; i < transactions.length; i += CHUNK) {
      const chunk = transactions.slice(i, i + CHUNK);
      const inserted = await tx
        .insert(schema.transactions)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ categoryId: schema.transactions.categoryId })
        .all();
      stats.inserted += inserted.length;
      stats.skipped += chunk.length - inserted.length;
      stats.autoCategorized += inserted.filter((row) => row.categoryId != null).length;
    }

    // Staged rows have served their purpose once committed
    await tx.delete(schema.stagedRows)
      .where(eq(schema.stagedRows.batchId, batchId))
      .run();
    const priorStats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
    await tx.update(schema.importBatches)
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
    // Then the legs whose far side keeps no ledger and so can never be paired.
    // After pairing, not before: a row with a real opposite leg should find it
    // rather than be filed against an account.
    stats.accountsLinked = await autoLinkAccountTransfers();
    if (stats.transfersLinked > 0 || stats.accountsLinked > 0) {
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
 *
 * `skipBatchIds` leaves named batches where they are, still in review. A bulk
 * run uses it to hold back a statement whose extraction did not tie out to its
 * own printed balances; the session stays open so those can be dealt with by
 * hand on the reconcile screen.
 */
export async function commitSession(
  sessionId: number,
  opts: { skipBatchIds?: number[] } = {},
): Promise<SessionCommitResult> {
  const batches = await db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.sessionId, sessionId))
    .orderBy(asc(schema.importBatches.id));

  const skip = new Set(opts.skipBatchIds ?? []);
  const stats = emptyStats();
  const committedBatchIds: number[] = [];
  const blocked: SessionCommitResult["blocked"] = [];

  for (const batch of batches) {
    if (batch.status === "committed" || batch.status === "discarded") continue;
    if (skip.has(batch.id)) {
      blocked.push({
        id: batch.id,
        filename: batch.filename,
        reason: "is held for review",
      });
      continue;
    }
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
    stats.accountsLinked = await autoLinkAccountTransfers();
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
