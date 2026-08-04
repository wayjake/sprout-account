import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import type { Account, AccountKind, AccountType } from "~/db/schema";
import { ACCOUNT_TYPE_LABELS, isLiability } from "~/lib/accounts";
import { formatCentsAbs } from "~/lib/money";
import { formatDate } from "~/lib/dates";

export { isLiability };

/**
 * Balances live on two legs:
 *   - anchors  — a known balance on a date (balance_snapshots), from a
 *                statement or typed in by hand;
 *   - activity — the transactions recorded after that anchor.
 * The current balance is anchor + activity. Reconciliation is the reverse
 * check: between two anchors the recorded activity must explain the change,
 * and where it doesn't we say what probably went wrong.
 *
 * Sign is always household perspective: assets positive, money owed negative.
 */

export interface Anchor {
  id: number;
  date: string;
  balanceCents: number;
  source: "import" | "manual";
}

export interface AccountBalance {
  account: Account;
  /** Most recent known balance, if any */
  anchor: Anchor | null;
  /** Sum of transactions dated after the anchor */
  activitySinceAnchorCents: number;
  activitySinceAnchorCount: number;
  /** anchor + activity. Null when nothing is known at all. */
  currentCents: number | null;
  /** Latest date the figure accounts for */
  asOfDate: string | null;
  /**
   * True when no anchor exists and the figure is just the sum of transactions —
   * a change in balance, not a balance. Shown as such in the UI.
   */
  unanchored: boolean;
}

/** Latest anchor per account, plus the activity recorded since it. */
export async function accountBalances(): Promise<AccountBalance[]> {
  const accounts = await db
    .select()
    .from(schema.accounts)
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);

  const snapshots = await db
    .select()
    .from(schema.balanceSnapshots)
    .orderBy(asc(schema.balanceSnapshots.date));

  const latestByAccount = new Map<number, Anchor>();
  for (const s of snapshots) {
    // ordered ascending, so the last write per account wins
    latestByAccount.set(s.accountId, {
      id: s.id,
      date: s.date,
      balanceCents: s.balanceCents,
      source: s.source,
    });
  }

  const activity = await db
    .select({
      accountId: schema.transactions.accountId,
      total: sql<number>`coalesce(sum(${schema.transactions.amountCents}), 0)`,
      count: sql<number>`count(*)`,
      maxDate: sql<string | null>`max(${schema.transactions.date})`,
    })
    .from(schema.transactions)
    .groupBy(schema.transactions.accountId);
  const activityByAccount = new Map(activity.map((a) => [a.accountId, a]));

  // Activity strictly after each account's latest anchor
  const sinceAnchor = new Map<number, { total: number; count: number }>();
  for (const [accountId, anchor] of latestByAccount) {
    const [row] = await db
      .select({
        total: sql<number>`coalesce(sum(${schema.transactions.amountCents}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, accountId),
          gt(schema.transactions.date, anchor.date),
        ),
      );
    sinceAnchor.set(accountId, { total: row?.total ?? 0, count: row?.count ?? 0 });
  }

  return accounts.map((account) => {
    const anchor = latestByAccount.get(account.id) ?? null;
    const since = sinceAnchor.get(account.id) ?? { total: 0, count: 0 };
    const all = activityByAccount.get(account.id);

    if (anchor) {
      const lastTxnDate = all?.maxDate ?? null;
      return {
        account,
        anchor,
        activitySinceAnchorCents: since.total,
        activitySinceAnchorCount: since.count,
        currentCents: anchor.balanceCents + since.total,
        asOfDate:
          lastTxnDate && lastTxnDate > anchor.date ? lastTxnDate : anchor.date,
        unanchored: false,
      };
    }

    // No anchor: for a transaction account the running total is only a delta,
    // for a balance-kind account there is simply nothing to report.
    const hasTxns = (all?.count ?? 0) > 0;
    return {
      account,
      anchor: null,
      activitySinceAnchorCents: all?.total ?? 0,
      activitySinceAnchorCount: all?.count ?? 0,
      currentCents: hasTxns ? (all?.total ?? 0) : null,
      asOfDate: all?.maxDate ?? null,
      unanchored: hasTxns,
    };
  });
}

// --- reconciliation ---

export type IssueSeverity = "error" | "warning" | "info";

export interface ReconcileIssue {
  severity: IssueSeverity;
  message: string;
  /** A concrete repair the user can act on, when we can name one */
  fix?: string;
}

export interface ReconcileWindow {
  fromDate: string | null;
  fromCents: number | null;
  toDate: string;
  toCents: number;
  /** fromCents + txnSumCents — what the statement balance should have been */
  expectedCents: number | null;
  /** toCents − expectedCents; zero means it reconciles */
  diffCents: number | null;
  txnSumCents: number;
  txnCount: number;
  /**
   * `movement` is not an error: on a balance-only account the gap between
   * consecutive statements and the contributions recorded against it *is* the
   * market return (or the interest accrued on a debt).
   */
  status: "ok" | "mismatch" | "movement" | "unanchored";
  /** Plain-language reading of a `movement` gap. */
  note?: string;
  issues: ReconcileIssue[];
}

export interface AccountReconciliation {
  accountId: number;
  accountName: string;
  accountType: AccountType;
  accountKind: AccountKind;
  windows: ReconcileWindow[];
  issues: ReconcileIssue[];
  status: "ok" | "mismatch" | "no_anchors";
}

/** Rows not yet committed, folded into the maths so import can preview the outcome. */
export interface PendingRows {
  txns: { accountId: number; date: string; amountCents: number; description: string }[];
  balances: { accountId: number; date: string; balanceCents: number }[];
}

interface WindowTxn {
  date: string;
  amountCents: number;
  description: string;
  pending: boolean;
}

const money = (cents: number) => formatCentsAbs(cents);

/**
 * Explain a gap between the statement balance and the recorded activity.
 * Ordered most-specific first: an exact single-row explanation is far more
 * useful than "you are off by $40".
 */
function diagnose(
  diffCents: number,
  txns: WindowTxn[],
  fromCents: number,
  toCents: number,
  fromDate: string | null,
  toDate: string,
): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  const range = fromDate ? `${formatDate(fromDate)} → ${formatDate(toDate)}` : formatDate(toDate);

  if (txns.length === 0) {
    issues.push({
      severity: "error",
      message: `The balance moved by ${money(toCents - fromCents)} over ${range} but no transactions are recorded for that period.`,
      fix: "Import the transaction file covering these dates.",
    });
    return issues;
  }

  // A single row whose removal reconciles exactly — almost always a double import
  const duplicate = txns.find((t) => t.amountCents === -diffCents);
  if (duplicate) {
    issues.push({
      severity: "error",
      message: `Off by ${money(diffCents)}, which is exactly "${duplicate.description}" on ${formatDate(duplicate.date)} (${money(duplicate.amountCents)}).`,
      fix: `Removing that one transaction reconciles this period exactly — check whether it was imported twice.`,
    });
    return issues;
  }

  // A single row with the wrong sign. Flipping t moves expected by −2t, so the
  // row that would reconcile the period is the one worth −diff/2.
  const flipped =
    diffCents % 2 === 0
      ? txns.find((t) => t.amountCents === -diffCents / 2 && t.amountCents !== 0)
      : undefined;
  if (flipped) {
    issues.push({
      severity: "error",
      message: `Off by ${money(diffCents)}, which is twice "${flipped.description}" on ${formatDate(flipped.date)} (${money(flipped.amountCents)}).`,
      fix: "That row's sign looks backwards — a charge recorded as a deposit, or vice versa.",
    });
    return issues;
  }

  // Every amount inverted — a debit/credit column mapping the wrong way round
  const sum = txns.reduce((n, t) => n + t.amountCents, 0);
  if (sum !== 0 && fromCents - sum === toCents) {
    issues.push({
      severity: "error",
      message: `Off by ${money(diffCents)} — but the balance reconciles exactly if every amount in this period is negated.`,
      fix: "The debit/credit columns are probably mapped the wrong way round for this file.",
    });
    return issues;
  }

  // Exact duplicate rows sitting in the window
  const seen = new Map<string, number>();
  for (const t of txns) {
    const key = `${t.date}|${t.amountCents}|${t.description.toUpperCase().trim()}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupeCount = [...seen.values()].filter((n) => n > 1).length;
  if (dupeCount > 0) {
    issues.push({
      severity: "warning",
      message: `${dupeCount} identical transaction${dupeCount === 1 ? "" : "s"} appear more than once in this period.`,
      fix: "Check the register for double-imported rows.",
    });
  }

  issues.push({
    severity: "error",
    message:
      diffCents > 0
        ? `Ledger is ${money(diffCents)} lower than the statement over ${range} — a charge may be duplicated, or a deposit missing.`
        : `Ledger is ${money(diffCents)} higher than the statement over ${range} — spending is probably missing from the import.`,
    fix: `${txns.length} transactions on record for this period, totalling ${money(sum)}.`,
  });
  return issues;
}

/**
 * What a `movement` gap on a balance-only account means in words. An asset
 * moved by the market; a debt grew by its interest.
 */
function movementNote(diffCents: number, accountType: AccountType): string {
  if (isLiability(accountType)) {
    return diffCents < 0
      ? `${money(diffCents)} interest & fees`
      : `${money(diffCents)} paid down beyond recorded payments`;
  }
  return diffCents > 0 ? `${money(diffCents)} market gain` : `${money(diffCents)} market loss`;
}

/**
 * Walk each account's anchors in date order and check that recorded activity
 * explains every move. `pending` rows are treated as though already committed,
 * which is how the import screen previews an outcome before writing anything.
 */
export async function reconcileAccounts(
  pending?: PendingRows,
  onlyAccountIds?: number[],
): Promise<AccountReconciliation[]> {
  const accounts = await db
    .select()
    .from(schema.accounts)
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);

  const scoped = onlyAccountIds
    ? accounts.filter((a) => onlyAccountIds.includes(a.id))
    : accounts;
  if (scoped.length === 0) return [];
  const ids = scoped.map((a) => a.id);

  const storedSnapshots = await db
    .select()
    .from(schema.balanceSnapshots)
    .where(inArray(schema.balanceSnapshots.accountId, ids));

  // Windows only ever span (anchor[i-1], anchor[i]], so nothing dated before
  // the earliest anchor can affect the result — no need to read it.
  const anchorDates = [
    ...storedSnapshots.map((s) => s.date),
    ...(pending?.balances ?? []).map((b) => b.date),
  ].sort();
  const earliestAnchor = anchorDates[0];

  const storedTxns = earliestAnchor
    ? await db
        .select({
          accountId: schema.transactions.accountId,
          date: schema.transactions.date,
          amountCents: schema.transactions.amountCents,
          description: schema.transactions.description,
        })
        .from(schema.transactions)
        .where(
          and(
            inArray(schema.transactions.accountId, ids),
            gt(schema.transactions.date, earliestAnchor),
          ),
        )
    : [];

  // Whether an account holds transactions at all is a separate question from
  // which ones fall inside a window — an unanchored account has no windows but
  // still deserves the nudge to set a balance.
  const txnCounts = await db
    .select({
      accountId: schema.transactions.accountId,
      count: sql<number>`count(*)`,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.accountId, ids))
    .groupBy(schema.transactions.accountId);
  const hasTxns = new Map(txnCounts.map((r) => [r.accountId, r.count > 0]));
  for (const t of pending?.txns ?? []) hasTxns.set(t.accountId, true);

  // Legs held in *other* accounts that name one of these as their far side.
  // A balance-only account keeps no ledger, so these are the only recorded
  // movements into or out of it. Sign is flipped to that account's
  // perspective: −1,000 leaving checking is +1,000 arriving here.
  const contributionRows = await db
    .select({
      targetAccountId: schema.transactions.transferAccountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      description: schema.transactions.description,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.transferAccountId, ids));

  const contributionsByAccount = new Map<number, WindowTxn[]>();
  for (const c of contributionRows) {
    if (c.targetAccountId == null) continue;
    if (!contributionsByAccount.has(c.targetAccountId)) {
      contributionsByAccount.set(c.targetAccountId, []);
    }
    contributionsByAccount.get(c.targetAccountId)!.push({
      date: c.date,
      amountCents: -c.amountCents,
      description: c.description,
      pending: false,
    });
  }

  // Fold pending rows in. A pending balance on a date that already has one
  // replaces it, matching the upsert that commit performs.
  const snapshotsByAccount = new Map<number, Map<string, number>>();
  for (const s of storedSnapshots) {
    if (!snapshotsByAccount.has(s.accountId)) snapshotsByAccount.set(s.accountId, new Map());
    snapshotsByAccount.get(s.accountId)!.set(s.date, s.balanceCents);
  }
  for (const b of pending?.balances ?? []) {
    if (!ids.includes(b.accountId)) continue;
    if (!snapshotsByAccount.has(b.accountId)) snapshotsByAccount.set(b.accountId, new Map());
    snapshotsByAccount.get(b.accountId)!.set(b.date, b.balanceCents);
  }

  const txnsByAccount = new Map<number, WindowTxn[]>();
  for (const t of storedTxns) {
    if (!txnsByAccount.has(t.accountId)) txnsByAccount.set(t.accountId, []);
    txnsByAccount.get(t.accountId)!.push({
      date: t.date,
      amountCents: t.amountCents,
      description: t.description,
      pending: false,
    });
  }
  for (const t of pending?.txns ?? []) {
    if (!ids.includes(t.accountId)) continue;
    if (!txnsByAccount.has(t.accountId)) txnsByAccount.set(t.accountId, []);
    txnsByAccount.get(t.accountId)!.push({
      date: t.date,
      amountCents: t.amountCents,
      description: t.description,
      pending: true,
    });
  }

  return scoped.map((account) => {
    const anchorMap = snapshotsByAccount.get(account.id) ?? new Map<string, number>();
    const anchors = [...anchorMap.entries()]
      .map(([date, balanceCents]) => ({ date, balanceCents }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const txns = (txnsByAccount.get(account.id) ?? []).sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    const issues: ReconcileIssue[] = [];

    // A positive balance on a debt means it is overpaid — real, but usually it
    // means a sign got dropped on the way in.
    if (isLiability(account.accountType)) {
      const positive = anchors.filter((a) => a.balanceCents > 0);
      if (positive.length > 0) {
        const noun = ACCOUNT_TYPE_LABELS[account.accountType].toLowerCase();
        issues.push({
          severity: "warning",
          message: `${positive.length} balance${positive.length === 1 ? "" : "s"} on this ${noun} ${positive.length === 1 ? "is" : "are"} positive.`,
          fix: "Money owed should be negative (−1,234.56). A positive figure means the account is overpaid.",
        });
      }
    }

    // A balance-only account has no ledger to check a statement against, but
    // contributions pointed at it from other accounts do explain part of every
    // move. What they don't explain is the market (or the interest on a debt),
    // and separating those two is the whole point of the exercise.
    if (account.kind === "balance" && anchors.length > 0) {
      const contributions = (contributionsByAccount.get(account.id) ?? []).sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      const windows: ReconcileWindow[] = [];

      for (let i = 0; i < anchors.length; i++) {
        const to = anchors[i];
        const from = i === 0 ? null : anchors[i - 1];
        if (!from) {
          windows.push({
            fromDate: null,
            fromCents: null,
            toDate: to.date,
            toCents: to.balanceCents,
            expectedCents: null,
            diffCents: null,
            txnSumCents: 0,
            txnCount: 0,
            status: "unanchored",
            issues: [],
          });
          continue;
        }
        const inWindow = contributions.filter(
          (c) => c.date > from.date && c.date <= to.date,
        );
        const contributed = inWindow.reduce((n, c) => n + c.amountCents, 0);
        const expected = from.balanceCents + contributed;
        const diff = to.balanceCents - expected;
        windows.push({
          fromDate: from.date,
          fromCents: from.balanceCents,
          toDate: to.date,
          toCents: to.balanceCents,
          expectedCents: expected,
          diffCents: diff,
          txnSumCents: contributed,
          txnCount: inWindow.length,
          status: diff === 0 ? "ok" : "movement",
          note: diff === 0 ? undefined : movementNote(diff, account.accountType),
          issues: [],
        });
      }

      if (contributions.length === 0 && anchors.length > 1) {
        issues.push({
          severity: "info",
          message:
            "Nothing is linked as a contribution to this account, so every move here reads as market movement.",
          fix: "On the funding account's transaction, use “Moved to…” to point it at this account.",
        });
      }

      return {
        accountId: account.id,
        accountName: account.name,
        accountType: account.accountType,
        accountKind: account.kind,
        windows,
        issues,
        // Market movement is not a discrepancy — a balance account never fails
        // to reconcile, it only reports what moved and why.
        status: "ok" as const,
      };
    }

    if (anchors.length === 0) {
      if (account.kind === "transaction" && hasTxns.get(account.id)) {
        issues.push({
          severity: "info",
          message: "No known balance for this account, so the running total is a change, not a balance.",
          fix: "Set a balance below, or close a month against a statement on Monthly Reconcile.",
        });
      }
      return {
        accountId: account.id,
        accountName: account.name,
        accountType: account.accountType,
        accountKind: account.kind,
        windows: [],
        issues,
        status: "no_anchors" as const,
      };
    }

    const windows: ReconcileWindow[] = [];
    for (let i = 0; i < anchors.length; i++) {
      const to = anchors[i];
      const from = i === 0 ? null : anchors[i - 1];

      const inWindow = txns.filter(
        (t) => (from ? t.date > from.date : false) && t.date <= to.date,
      );
      const txnSum = inWindow.reduce((n, t) => n + t.amountCents, 0);

      if (!from) {
        // Nothing before the first anchor to measure against
        windows.push({
          fromDate: null,
          fromCents: null,
          toDate: to.date,
          toCents: to.balanceCents,
          expectedCents: null,
          diffCents: null,
          txnSumCents: 0,
          txnCount: 0,
          status: "unanchored",
          issues: [],
        });
        continue;
      }

      const expected = from.balanceCents + txnSum;
      const diff = to.balanceCents - expected;
      windows.push({
        fromDate: from.date,
        fromCents: from.balanceCents,
        toDate: to.date,
        toCents: to.balanceCents,
        expectedCents: expected,
        diffCents: diff,
        txnSumCents: txnSum,
        txnCount: inWindow.length,
        status: diff === 0 ? "ok" : "mismatch",
        issues:
          diff === 0
            ? []
            : diagnose(diff, inWindow, from.balanceCents, to.balanceCents, from.date, to.date),
      });
    }

    const mismatched = windows.some((w) => w.status === "mismatch");
    return {
      accountId: account.id,
      accountName: account.name,
      accountType: account.accountType,
      accountKind: account.kind,
      windows,
      issues,
      status: mismatched ? ("mismatch" as const) : ("ok" as const),
    };
  });
}

// --- per-row cleared state ---

/**
 * A period between two anchors, and whether the ledger explained it. Cleared
 * state is *derived* from these rather than stored on the row: a transaction is
 * reconciled because the period containing it ties out, so editing a row
 * correctly un-reconciles its whole period instead of leaving a stale flag.
 */
export interface ClearedWindow {
  /** exclusive — the anchor this period runs from */
  fromDate: string;
  /** inclusive — the anchor this period runs to */
  toDate: string;
  reconciles: boolean;
}

export type ClearedState =
  /** inside a period whose statement balance the ledger explains exactly */
  | "reconciled"
  /** inside a period that does not tie out — something here is wrong */
  | "mismatch"
  /** before the first known balance, or after the last: nothing checks it yet */
  | "open";

/**
 * Checked periods per account, for marking individual rows in the register.
 *
 * The window maths must stay identical to `reconcileAccounts` — same
 * (previous anchor, this anchor] span, same `expected = from + activity`, same
 * zero-diff test — or a row would claim to be reconciled while the account
 * screen says the period is off. This reads per-date sums instead of whole
 * transactions because the register calls it on every page load.
 *
 * Balance-kind accounts are skipped: they keep no ledger, so no row can be in
 * one of their windows, and their windows measure contributions anyway.
 */
export async function clearedWindows(): Promise<Map<number, ClearedWindow[]>> {
  const accounts = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.kind, "transaction"));
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return new Map();

  const snapshots = await db
    .select({
      accountId: schema.balanceSnapshots.accountId,
      date: schema.balanceSnapshots.date,
      balanceCents: schema.balanceSnapshots.balanceCents,
    })
    .from(schema.balanceSnapshots)
    .where(inArray(schema.balanceSnapshots.accountId, ids));
  if (snapshots.length === 0) return new Map();

  const dailyTotals = await db
    .select({
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      total: sql<number>`coalesce(sum(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.accountId, ids))
    .groupBy(schema.transactions.accountId, schema.transactions.date);

  const totalsByAccount = new Map<number, { date: string; total: number }[]>();
  for (const row of dailyTotals) {
    if (!totalsByAccount.has(row.accountId)) totalsByAccount.set(row.accountId, []);
    totalsByAccount.get(row.accountId)!.push({ date: row.date, total: row.total });
  }

  const anchorsByAccount = new Map<number, { date: string; balanceCents: number }[]>();
  for (const s of snapshots) {
    if (!anchorsByAccount.has(s.accountId)) anchorsByAccount.set(s.accountId, []);
    anchorsByAccount.get(s.accountId)!.push({
      date: s.date,
      balanceCents: s.balanceCents,
    });
  }

  const result = new Map<number, ClearedWindow[]>();
  for (const [accountId, rawAnchors] of anchorsByAccount) {
    const anchors = [...rawAnchors].sort((a, b) => a.date.localeCompare(b.date));
    const totals = totalsByAccount.get(accountId) ?? [];
    const windows: ClearedWindow[] = [];
    // The first anchor has nothing before it to measure against, so it opens no
    // window — same as reconcileAccounts' `unanchored` first row.
    for (let i = 1; i < anchors.length; i++) {
      const from = anchors[i - 1];
      const to = anchors[i];
      const activity = totals
        .filter((t) => t.date > from.date && t.date <= to.date)
        .reduce((n, t) => n + t.total, 0);
      windows.push({
        fromDate: from.date,
        toDate: to.date,
        reconciles: to.balanceCents - (from.balanceCents + activity) === 0,
      });
    }
    if (windows.length > 0) result.set(accountId, windows);
  }
  return result;
}

/** Where one row falls among its account's checked periods. */
export function clearedStateFor(
  windows: ClearedWindow[] | undefined,
  date: string,
): ClearedState {
  const hit = windows?.find((w) => date > w.fromDate && date <= w.toDate);
  if (!hit) return "open";
  return hit.reconciles ? "reconciled" : "mismatch";
}

/** Set (or replace) a known balance by hand. */
export async function setManualBalance(input: {
  accountId: number;
  date: string;
  balanceCents: number;
  note?: string | null;
}) {
  await db
    .insert(schema.balanceSnapshots)
    .values({
      accountId: input.accountId,
      date: input.date,
      balanceCents: input.balanceCents,
      source: "manual",
      note: input.note ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
      set: {
        balanceCents: input.balanceCents,
        source: "manual",
        note: input.note ?? null,
        importBatchId: null,
      },
    });
}

export async function deleteBalance(id: number) {
  await db.delete(schema.balanceSnapshots).where(eq(schema.balanceSnapshots.id, id));
}

/** Every known balance for an account, newest first. */
export async function listBalances(accountId: number) {
  return db
    .select()
    .from(schema.balanceSnapshots)
    .where(eq(schema.balanceSnapshots.accountId, accountId))
    .orderBy(sql`${schema.balanceSnapshots.date} desc`);
}

/** Balance history for every account, for charting. */
export async function balanceHistory(accountId: number, before?: string) {
  const conds = [eq(schema.balanceSnapshots.accountId, accountId)];
  if (before) conds.push(lte(schema.balanceSnapshots.date, before));
  return db
    .select()
    .from(schema.balanceSnapshots)
    .where(and(...conds))
    .orderBy(asc(schema.balanceSnapshots.date));
}
