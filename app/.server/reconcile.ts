import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import type { StagedBalanceData, StagedTxnData } from "~/.server/import/stage";

/**
 * The month-end close. A statement is not a source of transactions the way a
 * CSV export is — it is the authority the ledger gets checked against. Every
 * line on it is matched to what the books already hold (`stage.ts` does the
 * matching); what is left over is the gap, and filling that gap is the only
 * way a close writes transactions.
 *
 * Balances are the other half: a statement's opening and closing figures become
 * the anchors that `reconcileAccounts` measures activity between.
 */

export interface StatementRow {
  /** staged_rows.id — what the include/exclude toggle acts on */
  id: number;
  date: string;
  description: string;
  amountCents: number;
  /** The ledger row this line was matched to, if the books already had it */
  matchedDate: string | null;
  matchedDescription: string | null;
  /** The books hold this transaction, but pointing the other way */
  signConflict: boolean;
  matchedAmountCents: number | null;
  /** Will be written to the ledger when the close is committed */
  included: boolean;
}

export interface StatementBalance {
  id: number;
  date: string;
  balanceCents: number;
  kind: string | null;
  /** A balance already on file for this date, when this one would replace it */
  replaces: number | null;
  included: boolean;
}

export interface StatementClose {
  batchId: number;
  filename: string;
  status: string;
  accountId: number | null;
  accountLabel: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rows: StatementRow[];
  balances: StatementBalance[];
  /** Lines the books already had */
  matchedCount: number;
  /** Lines missing from the books, and what they come to */
  missingCount: number;
  missingTotalCents: number;
  /** Missing lines the user has chosen not to add */
  skippedCount: number;
  /** Lines the books hold with the opposite sign — a real discrepancy */
  signConflictCount: number;
  priorWarning: string | null;
  accountAssignment: string | null;
  extractionProblems: string[];
  committed: {
    inserted: number;
    balancesRecorded: number;
    autoCategorized: number;
  } | null;
}

const INCLUDED_STATUSES = ["new", "possible_duplicate"];

/**
 * Every statement in one close, with its lines sorted into "the books had this"
 * and "the books are missing this".
 */
export async function statementCloses(sessionId: number): Promise<StatementClose[]> {
  const batches = await db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.sessionId, sessionId))
    .orderBy(asc(schema.importBatches.id));

  const batchIds = batches.map((b) => b.id);
  const staged =
    batchIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.stagedRows)
          .where(inArray(schema.stagedRows.batchId, batchIds))
          .orderBy(asc(schema.stagedRows.rowIndex));

  // A statement balance for a date already on file replaces it rather than
  // adding a second anchor — worth saying out loud before it happens.
  const accountIds = [
    ...new Set(batches.map((b) => b.accountId).filter((id): id is number => id != null)),
  ];
  const existingAnchors =
    accountIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.balanceSnapshots)
          .where(inArray(schema.balanceSnapshots.accountId, accountIds));
  const anchorByKey = new Map(
    existingAnchors.map((a) => [`${a.accountId}|${a.date}`, a.balanceCents]),
  );

  const byBatch = new Map<number, typeof staged>();
  for (const row of staged) {
    if (!byBatch.has(row.batchId)) byBatch.set(row.batchId, []);
    byBatch.get(row.batchId)!.push(row);
  }

  return batches
    .filter((b) => b.status !== "discarded")
    .map((batch) => {
      const stats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
      const mine = byBatch.get(batch.id) ?? [];

      const rows: StatementRow[] = [];
      const balances: StatementBalance[] = [];
      for (const row of mine) {
        if (row.rowKind === "balance") {
          const d = JSON.parse(row.dataJson) as StagedBalanceData;
          balances.push({
            id: row.id,
            date: d.date,
            balanceCents: d.balanceCents,
            kind: d.kind ?? null,
            replaces: anchorByKey.get(`${batch.accountId}|${d.date}`) ?? null,
            included: INCLUDED_STATUSES.includes(row.status),
          });
          continue;
        }
        const d = JSON.parse(row.dataJson) as StagedTxnData;
        rows.push({
          id: row.id,
          date: d.date,
          description: d.description,
          amountCents: d.amountCents,
          matchedDate: d.matchedDate ?? null,
          matchedDescription: d.matchedDescription ?? null,
          signConflict: d.signConflict === true,
          matchedAmountCents: d.matchedAmountCents ?? null,
          included:
            INCLUDED_STATUSES.includes(row.status) && row.supersededByBatchId == null,
        });
      }
      rows.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      balances.sort((a, b) => a.date.localeCompare(b.date));

      // "Matched" is the row's own finding, not the user's choice: a line the
      // books already had stays matched even if the user forces it in anyway.
      // Sign conflicts are counted on their own — the books do hold them, but
      // calling them matched would hide a real disagreement inside a tally that
      // reads as "all clear".
      const matched = rows.filter((r) => r.matchedDate != null && !r.signConflict);
      const missing = rows.filter((r) => r.matchedDate == null);

      return {
        batchId: batch.id,
        filename: batch.filename,
        status: batch.status,
        accountId: batch.accountId,
        accountLabel: batch.accountLabel,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
        rows,
        balances,
        matchedCount: matched.length,
        missingCount: missing.length,
        missingTotalCents: missing
          .filter((r) => r.included)
          .reduce((n, r) => n + r.amountCents, 0),
        skippedCount: missing.filter((r) => !r.included).length,
        signConflictCount: rows.filter((r) => r.signConflict).length,
        priorWarning: (stats.priorWarning ?? null) as string | null,
        accountAssignment: (stats.accountAssignment ?? null) as string | null,
        extractionProblems: (stats.extractionProblems ?? []) as string[],
        committed:
          batch.status === "committed"
            ? {
                inserted: stats.inserted ?? 0,
                balancesRecorded: stats.balancesRecorded ?? 0,
                autoCategorized: stats.autoCategorized ?? 0,
              }
            : null,
      };
    });
}

export interface CloseHistoryEntry {
  sessionId: number;
  status: string;
  createdAt: number;
  committedAt: number | null;
  statements: number;
  accounts: string[];
  periodStart: string | null;
  periodEnd: string | null;
  inserted: number;
  balancesRecorded: number;
}

/** Past closes, newest first, for the Monthly Reconcile screen's history. */
export async function closeHistory(limit = 12): Promise<CloseHistoryEntry[]> {
  const sessions = await db
    .select()
    .from(schema.importSessions)
    .where(eq(schema.importSessions.purpose, "reconcile"))
    .orderBy(desc(schema.importSessions.id))
    .limit(limit);
  if (sessions.length === 0) return [];

  const batches = await db
    .select()
    .from(schema.importBatches)
    .where(
      and(
        inArray(
          schema.importBatches.sessionId,
          sessions.map((s) => s.id),
        ),
      ),
    );

  return sessions.map((session) => {
    const mine = batches.filter(
      (b) => b.sessionId === session.id && b.status !== "discarded",
    );
    const stats = mine.map((b) => (b.statsJson ? JSON.parse(b.statsJson) : {}));
    const starts = mine.map((b) => b.periodStart).filter((d): d is string => d != null);
    const ends = mine.map((b) => b.periodEnd).filter((d): d is string => d != null);
    return {
      sessionId: session.id,
      status: session.status,
      createdAt: session.createdAt,
      committedAt: session.committedAt,
      statements: mine.length,
      accounts: [
        ...new Set(mine.map((b) => b.accountLabel).filter((l): l is string => l != null)),
      ],
      periodStart: starts.sort()[0] ?? null,
      periodEnd: ends.sort().at(-1) ?? null,
      inserted: stats.reduce((n, s) => n + (s.inserted ?? 0), 0),
      balancesRecorded: stats.reduce((n, s) => n + (s.balancesRecorded ?? 0), 0),
    };
  });
}
