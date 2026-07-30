import { eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";

/** Max calendar days between the two legs of a transfer. */
export const TRANSFER_WINDOW_DAYS = 5;

/** Descriptions that read like account-to-account movement, not purchases. */
const TRANSFER_HINT =
  /\b(TRANSFER|XFER|PAYMENT|PMT|PYMT|AUTOPAY|EPAY|BILLPAY|BILL PAY|THANK YOU|DIRECTPAY|DIRECT PAY)\b/i;

export function looksLikeTransfer(description: string): boolean {
  return TRANSFER_HINT.test(description);
}

export interface TransferLeg {
  id: number;
  date: string;
  amountCents: number;
  description: string;
  accountId: number;
  accountName: string;
}

export interface TransferSuggestion {
  out: TransferLeg;
  in: TransferLeg;
  dayDiff: number;
  hinted: boolean;
}

interface RawPair {
  out_id: number;
  out_date: string;
  out_amount: number;
  out_desc: string;
  out_account_id: number;
  out_account: string;
  in_id: number;
  in_date: string;
  in_amount: number;
  in_desc: string;
  in_account_id: number;
  in_account: string;
  day_diff: number;
}

/**
 * All plausible transfer pairs: opposite amounts, different accounts, within
 * the date window, both legs unpaired and either uncategorized or already
 * transfer-class, pair not previously dismissed.
 */
async function rawCandidatePairs(): Promise<RawPair[]> {
  return db.all<RawPair>(sql`
    with transfer_cats as (
      select id from categories where spending_class = 'transfer'
    )
    select o.id as out_id, o.date as out_date, o.amount_cents as out_amount,
           o.description as out_desc, o.account_id as out_account_id, oa.name as out_account,
           i.id as in_id, i.date as in_date, i.amount_cents as in_amount,
           i.description as in_desc, i.account_id as in_account_id, ia.name as in_account,
           abs(julianday(i.date) - julianday(o.date)) as day_diff
    from transactions o
    join transactions i
      on i.amount_cents = -o.amount_cents
      and i.account_id != o.account_id
      and abs(julianday(i.date) - julianday(o.date)) <= ${TRANSFER_WINDOW_DAYS}
    join accounts oa on oa.id = o.account_id
    join accounts ia on ia.id = i.account_id
    where o.amount_cents < 0
      and o.transfer_peer_id is null and i.transfer_peer_id is null
      and (o.category_id is null or o.category_id in (select id from transfer_cats))
      and (i.category_id is null or i.category_id in (select id from transfer_cats))
      and not exists (
        select 1 from transfer_rejections r
        where r.txn_a_id = min(o.id, i.id) and r.txn_b_id = max(o.id, i.id)
      )
    order by day_diff asc, o.date desc, o.id desc
  `);
}

function toSuggestion(p: RawPair): TransferSuggestion {
  return {
    out: {
      id: p.out_id,
      date: p.out_date,
      amountCents: p.out_amount,
      description: p.out_desc,
      accountId: p.out_account_id,
      accountName: p.out_account,
    },
    in: {
      id: p.in_id,
      date: p.in_date,
      amountCents: p.in_amount,
      description: p.in_desc,
      accountId: p.in_account_id,
      accountName: p.in_account,
    },
    dayDiff: Math.round(p.day_diff),
    hinted: TRANSFER_HINT.test(p.out_desc) || TRANSFER_HINT.test(p.in_desc),
  };
}

/**
 * Greedy one-to-one matching: pairs sorted by date proximity, each
 * transaction used at most once.
 */
export async function findTransferSuggestions(limit = 100): Promise<TransferSuggestion[]> {
  const pairs = await rawCandidatePairs();
  const used = new Set<number>();
  const out: TransferSuggestion[] = [];
  for (const p of pairs) {
    if (used.has(p.out_id) || used.has(p.in_id)) continue;
    used.add(p.out_id);
    used.add(p.in_id);
    out.push(toSuggestion(p));
    if (out.length >= limit) break;
  }
  return out;
}

/** Candidate opposite legs for one specific transaction (for the detail page). */
export async function findCandidatesFor(txnId: number): Promise<TransferSuggestion[]> {
  const pairs = await rawCandidatePairs();
  return pairs
    .filter((p) => p.out_id === txnId || p.in_id === txnId)
    .slice(0, 8)
    .map(toSuggestion);
}

/**
 * Pick the category for a linked pair: "Credit Card Payment" when a credit
 * card is involved, else "Transfer"; any transfer-class category as fallback,
 * created if the user deleted them all.
 */
async function transferCategoryId(accountA: schema.Account, accountB: schema.Account) {
  const cats = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.spendingClass, "transfer"))
    .orderBy(schema.categories.sortOrder);
  const wantCc =
    accountA.accountType === "credit_card" || accountB.accountType === "credit_card";
  const byName = (name: string) =>
    cats.find((c) => !c.isArchived && c.name.toLowerCase() === name.toLowerCase());
  const pick =
    (wantCc ? byName("Credit Card Payment") : undefined) ??
    byName("Transfer") ??
    cats.find((c) => !c.isArchived) ??
    cats[0];
  if (pick) return pick.id;
  const [created] = await db
    .insert(schema.categories)
    .values({ name: "Transfer", spendingClass: "transfer", sortOrder: 40 })
    .returning();
  return created.id;
}

/**
 * Link two transactions as the two legs of one transfer. Both get the peer
 * pointer and a transfer-class category so they drop out of income/spend.
 * Returns an error string, or null on success.
 */
export async function linkTransferPair(
  outId: number,
  inId: number,
  source: "user" | "auto",
): Promise<string | null> {
  if (outId === inId) return "A transfer needs two different transactions";
  const legs = await db.query.transactions.findMany({
    where: (t, { inArray }) => inArray(t.id, [outId, inId]),
    with: { account: true },
  });
  const a = legs.find((l) => l.id === outId);
  const b = legs.find((l) => l.id === inId);
  if (!a || !b) return "Transaction not found";
  if (a.accountId === b.accountId) return "Both legs are in the same account";
  if (a.amountCents !== -b.amountCents)
    return "Amounts must be equal and opposite";
  if (a.transferPeerId != null || b.transferPeerId != null)
    return "One of these is already linked to a transfer";

  const categoryId = await transferCategoryId(a.account, b.account);
  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ transferPeerId: b.id, categoryId, categorySource: source })
      .where(eq(schema.transactions.id, a.id))
      .run();
    tx.update(schema.transactions)
      .set({ transferPeerId: a.id, categoryId, categorySource: source })
      .where(eq(schema.transactions.id, b.id))
      .run();
  });
  return null;
}

/** Undo a pair link. Categories are left alone. Returns the peer id, if any. */
export async function unlinkTransfer(txnId: number): Promise<number | null> {
  const txn = await db.query.transactions.findFirst({
    where: eq(schema.transactions.id, txnId),
  });
  if (!txn?.transferPeerId) return null;
  const peerId = txn.transferPeerId;
  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ transferPeerId: null })
      .where(eq(schema.transactions.id, txnId))
      .run();
    tx.update(schema.transactions)
      .set({ transferPeerId: null })
      .where(eq(schema.transactions.id, peerId))
      .run();
  });
  return peerId;
}

/** Remember that a suggested pair is NOT a transfer. */
export async function rejectTransferPair(idA: number, idB: number) {
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA];
  await db
    .insert(schema.transferRejections)
    .values({ txnAId: lo, txnBId: hi })
    .onConflictDoNothing();
}

/**
 * Auto-link the safe subset of suggestions: description on at least one leg
 * reads like a transfer AND the match is mutually unambiguous (each leg has
 * exactly one candidate). Everything else stays a suggestion for review.
 */
export async function autoLinkTransfers(): Promise<number> {
  const pairs = await rawCandidatePairs();
  const outCount = new Map<number, number>();
  const inCount = new Map<number, number>();
  for (const p of pairs) {
    outCount.set(p.out_id, (outCount.get(p.out_id) ?? 0) + 1);
    inCount.set(p.in_id, (inCount.get(p.in_id) ?? 0) + 1);
  }
  let linked = 0;
  for (const p of pairs) {
    if (outCount.get(p.out_id) !== 1 || inCount.get(p.in_id) !== 1) continue;
    if (!TRANSFER_HINT.test(p.out_desc) && !TRANSFER_HINT.test(p.in_desc)) continue;
    const err = await linkTransferPair(p.out_id, p.in_id, "auto");
    if (!err) linked++;
  }
  return linked;
}

/** Transfer legs (transfer-class category) whose opposite side is missing. */
export async function unmatchedTransferLegs(limit = 50): Promise<TransferLeg[]> {
  const rows = await db.all<{
    id: number;
    date: string;
    amount_cents: number;
    description: string;
    account_id: number;
    account_name: string;
  }>(sql`
    select t.id, t.date, t.amount_cents, t.description,
           t.account_id, a.name as account_name
    from transactions t
    join accounts a on a.id = t.account_id
    join categories c on c.id = t.category_id
    where c.spending_class = 'transfer' and t.transfer_peer_id is null
    order by t.date desc, t.id desc
    limit ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amountCents: r.amount_cents,
    description: r.description,
    accountId: r.account_id,
    accountName: r.account_name,
  }));
}

/** Recently linked pairs, newest first (keyed off the outgoing leg). */
export async function linkedTransfers(limit = 30): Promise<TransferSuggestion[]> {
  const rows = await db.all<RawPair>(sql`
    select o.id as out_id, o.date as out_date, o.amount_cents as out_amount,
           o.description as out_desc, o.account_id as out_account_id, oa.name as out_account,
           i.id as in_id, i.date as in_date, i.amount_cents as in_amount,
           i.description as in_desc, i.account_id as in_account_id, ia.name as in_account,
           abs(julianday(i.date) - julianday(o.date)) as day_diff
    from transactions o
    join transactions i on i.id = o.transfer_peer_id
    join accounts oa on oa.id = o.account_id
    join accounts ia on ia.id = i.account_id
    where o.amount_cents < 0
    order by o.date desc, o.id desc
    limit ${limit}
  `);
  return rows.map(toSuggestion);
}

/** Total gold moved between own accounts in a date range (outgoing legs). */
export async function transferVolume(fromDate: string, toDate: string): Promise<number> {
  const [row] = await db.all<{ total: number | null }>(sql`
    select sum(-t.amount_cents) as total
    from transactions t
    where t.transfer_peer_id is not null and t.amount_cents < 0
      and t.date >= ${fromDate} and t.date <= ${toDate}
  `);
  return row?.total ?? 0;
}
