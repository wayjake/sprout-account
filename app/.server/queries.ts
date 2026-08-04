import { and, desc, eq, inArray, isNull, like, lt, not, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { clearedStateFor, clearedWindows, type ClearedWindow } from "~/.server/balances";
import type { SpendingClass } from "~/db/schema";

export const PAGE_SIZE = 50;

export interface TransactionFilters {
  accountId?: number;
  /** numeric category id, or "none" for uncategorized */
  categoryId?: number | "none";
  spendingClass?: SpendingClass;
  from?: string;
  to?: string;
  q?: string;
  /** "yes" — inside a period that ties out; "no" — everything else */
  reconciled?: "yes" | "no";
}

export function parseTransactionFilters(url: URL): TransactionFilters {
  const p = url.searchParams;
  const num = (key: string) => {
    const v = p.get(key);
    if (!v) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const category = p.get("category");
  return {
    accountId: num("account"),
    categoryId: category === "none" ? "none" : num("category"),
    spendingClass: (schema.SPENDING_CLASSES as readonly string[]).includes(
      p.get("class") ?? "",
    )
      ? (p.get("class") as SpendingClass)
      : undefined,
    from: /^\d{4}-\d{2}-\d{2}$/.test(p.get("from") ?? "")
      ? p.get("from")!
      : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(p.get("to") ?? "") ? p.get("to")! : undefined,
    q: p.get("q")?.trim() || undefined,
    reconciled:
      p.get("reconciled") === "yes"
        ? "yes"
        : p.get("reconciled") === "no"
          ? "no"
          : undefined,
  };
}

/**
 * Turn the derived cleared periods into a SQL predicate, so the filter narrows
 * the query itself rather than the page — filtering after pagination would
 * hand back short pages and a cursor that skips rows.
 */
function reconciledCondition(
  windows: Map<number, ClearedWindow[]>,
  mode: "yes" | "no",
): SQL {
  const t = schema.transactions;
  const spans: SQL[] = [];
  for (const [accountId, list] of windows) {
    for (const w of list) {
      if (!w.reconciles) continue;
      spans.push(
        and(
          eq(t.accountId, accountId),
          sql`${t.date} > ${w.fromDate}`,
          sql`${t.date} <= ${w.toDate}`,
        )!,
      );
    }
  }
  // Nothing reconciles yet: "yes" matches no row, "no" matches every row.
  if (spans.length === 0) return mode === "yes" ? sql`0 = 1` : sql`1 = 1`;
  const inAny = or(...spans)!;
  return mode === "yes" ? inAny : not(inAny);
}

function filterConditions(f: TransactionFilters): SQL[] {
  const t = schema.transactions;
  const conds: SQL[] = [];
  if (f.accountId) conds.push(eq(t.accountId, f.accountId));
  if (f.categoryId === "none") conds.push(isNull(t.categoryId));
  else if (f.categoryId) conds.push(eq(t.categoryId, f.categoryId));
  if (f.spendingClass)
    conds.push(
      sql`${t.categoryId} in (select id from categories where spending_class = ${f.spendingClass})`,
    );
  if (f.from) conds.push(sql`${t.date} >= ${f.from}`);
  if (f.to) conds.push(sql`${t.date} <= ${f.to}`);
  if (f.q) {
    const pattern = `%${f.q.replace(/[%_]/g, "")}%`;
    conds.push(
      or(like(t.description, pattern), like(t.merchant, pattern))!,
    );
  }
  return conds;
}

export interface Cursor {
  date: string;
  id: number;
}

export function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf("~");
  if (idx === -1) return null;
  const date = raw.slice(0, idx);
  const id = Number(raw.slice(idx + 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(id)) return null;
  return { date, id };
}

export function serializeCursor(c: Cursor): string {
  return `${c.date}~${c.id}`;
}

export async function listTransactions(
  filters: TransactionFilters,
  cursor: Cursor | null,
  limit = PAGE_SIZE,
) {
  const t = schema.transactions;
  const conds = filterConditions(filters);
  // Needed for the per-row marker whether or not the filter is on, so it is
  // fetched once and used for both.
  const windows = await clearedWindows();
  if (filters.reconciled) {
    conds.push(reconciledCondition(windows, filters.reconciled));
  }
  if (cursor) {
    conds.push(
      or(
        lt(t.date, cursor.date),
        and(eq(t.date, cursor.date), lt(t.id, cursor.id)),
      )!,
    );
  }

  const rows = await db
    .select({
      id: t.id,
      date: t.date,
      amountCents: t.amountCents,
      description: t.description,
      merchant: t.merchant,
      notes: t.notes,
      categoryId: t.categoryId,
      categorySource: t.categorySource,
      transferPeerId: t.transferPeerId,
      transferPeerAccount: sql<string | null>`(
        select pa.name from transactions p
        join accounts pa on pa.id = p.account_id
        where p.id = ${t.transferPeerId}
      )`,
      accountId: t.accountId,
      accountName: schema.accounts.name,
      categoryName: schema.categories.name,
      spendingClass: schema.categories.spendingClass,
      splitCount: sql<number>`(
        select count(*) from transaction_splits s where s.transaction_id = ${t.id}
      )`,
    })
    .from(t)
    .leftJoin(schema.accounts, eq(t.accountId, schema.accounts.id))
    .leftJoin(schema.categories, eq(t.categoryId, schema.categories.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(t.date), desc(t.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      ...r,
      cleared: clearedStateFor(windows.get(r.accountId), r.date),
    })),
    nextCursor:
      hasMore && last ? serializeCursor({ date: last.date, id: last.id }) : null,
  };
}

export type TransactionListRow = Awaited<
  ReturnType<typeof listTransactions>
>["rows"][number];

/**
 * Transactions inserted by a set of import batches, for the post-import
 * categorize screen. Auto-linked transfer legs are excluded — they already
 * carry a transfer-class category from `autoLinkTransfers` and drop out of
 * income/spend reporting, so they don't belong in a categorization queue.
 */
export async function listImportedTransactions(batchIds: number[]) {
  if (batchIds.length === 0) return [];
  const t = schema.transactions;
  return db
    .select({
      id: t.id,
      date: t.date,
      amountCents: t.amountCents,
      description: t.description,
      merchant: t.merchant,
      categoryId: t.categoryId,
      categorySource: t.categorySource,
      accountId: t.accountId,
      accountName: schema.accounts.name,
      categoryName: schema.categories.name,
      spendingClass: schema.categories.spendingClass,
    })
    .from(t)
    .leftJoin(schema.accounts, eq(t.accountId, schema.accounts.id))
    .leftJoin(schema.categories, eq(t.categoryId, schema.categories.id))
    .where(and(inArray(t.importBatchId, batchIds), isNull(t.transferPeerId)))
    .orderBy(desc(t.date), desc(t.id));
}

export type ImportedTransactionRow = Awaited<
  ReturnType<typeof listImportedTransactions>
>[number];

// --- dashboard aggregates ---
// "Effective" rows: splits replace their parent transaction so category/class
// aggregates honor item-level splits.
const EFFECTIVE_CTE = sql`
  with effective as (
    select t.date as date, s.amount_cents as amount_cents, s.category_id as category_id
    from transaction_splits s
    join transactions t on t.id = s.transaction_id
    union all
    select t.date, t.amount_cents, t.category_id
    from transactions t
    where not exists (select 1 from transaction_splits s where s.transaction_id = t.id)
  )
`;

export interface MonthClassRow {
  month: string;
  spendingClass: SpendingClass | null;
  totalCents: number;
}

/** Spending per month per class (negative amounts only, transfers excluded,
 *  uncategorized spend included as class null). */
export async function spendByMonthAndClass(
  fromDate: string,
  toDate: string,
): Promise<MonthClassRow[]> {
  const rows = await db.all<{
    month: string;
    spending_class: string | null;
    total: number;
  }>(sql`
    ${EFFECTIVE_CTE}
    select substr(e.date, 1, 7) as month,
           c.spending_class as spending_class,
           sum(e.amount_cents) as total
    from effective e
    left join categories c on c.id = e.category_id
    where e.date >= ${fromDate} and e.date <= ${toDate}
      and e.amount_cents < 0
      and (c.spending_class is null or c.spending_class in ('base', 'living', 'luxury'))
    group by month, spending_class
    order by month
  `);
  return rows.map((r) => ({
    month: r.month,
    spendingClass: (r.spending_class ?? null) as SpendingClass | null,
    totalCents: r.total,
  }));
}

/** Income per month (positive amounts in income-class categories). */
export async function incomeByMonth(
  fromDate: string,
  toDate: string,
): Promise<{ month: string; totalCents: number }[]> {
  const rows = await db.all<{ month: string; total: number }>(sql`
    ${EFFECTIVE_CTE}
    select substr(e.date, 1, 7) as month, sum(e.amount_cents) as total
    from effective e
    join categories c on c.id = e.category_id
    where e.date >= ${fromDate} and e.date <= ${toDate}
      and e.amount_cents > 0 and c.spending_class = 'income'
    group by month
    order by month
  `);
  return rows.map((r) => ({ month: r.month, totalCents: r.total }));
}

/** Top spending categories over a range (splits honored, transfers/income excluded). */
export async function topCategories(fromDate: string, toDate: string, limit = 8) {
  const rows = await db.all<{
    id: number | null;
    name: string | null;
    spending_class: string | null;
    total: number;
  }>(sql`
    ${EFFECTIVE_CTE}
    select c.id as id, c.name as name, c.spending_class as spending_class,
           sum(e.amount_cents) as total
    from effective e
    left join categories c on c.id = e.category_id
    where e.date >= ${fromDate} and e.date <= ${toDate}
      and e.amount_cents < 0
      and (c.spending_class is null or c.spending_class in ('base', 'living', 'luxury'))
    group by c.id
    order by total asc
    limit ${limit}
  `);
  return rows.map((r) => ({
    categoryId: r.id,
    name: r.name ?? "Uncategorized",
    spendingClass: (r.spending_class ?? null) as SpendingClass | null,
    totalCents: r.total,
  }));
}

/** Balance snapshot series for all balance-kind accounts. */
export async function balanceTrends() {
  const rows = await db
    .select({
      accountId: schema.balanceSnapshots.accountId,
      accountName: schema.accounts.name,
      date: schema.balanceSnapshots.date,
      balanceCents: schema.balanceSnapshots.balanceCents,
    })
    .from(schema.balanceSnapshots)
    .innerJoin(
      schema.accounts,
      eq(schema.balanceSnapshots.accountId, schema.accounts.id),
    )
    .orderBy(schema.balanceSnapshots.accountId, schema.balanceSnapshots.date);

  const series = new Map<
    number,
    { accountId: number; accountName: string; points: { date: string; balanceCents: number }[] }
  >();
  for (const r of rows) {
    if (!series.has(r.accountId)) {
      series.set(r.accountId, {
        accountId: r.accountId,
        accountName: r.accountName,
        points: [],
      });
    }
    series.get(r.accountId)!.points.push({ date: r.date, balanceCents: r.balanceCents });
  }
  return [...series.values()];
}
