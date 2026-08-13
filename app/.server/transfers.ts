import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db, schema } from "~/.server/db";
import { matchAccountByHint, paymentCategoryName } from "~/lib/accounts";

/** Max calendar days between the two legs of a transfer. */
export const TRANSFER_WINDOW_DAYS = 5;

/** Descriptions that read like account-to-account movement, not purchases. */
const TRANSFER_HINT =
  /\b(TRANSFER|XFER|PAYMENT|PMT|PYMT|AUTOPAY|AUTO PAY|EPAY|BILLPAY|BILL PAY|THANK YOU|DIRECTPAY|DIRECT PAY)\b/i;

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
      and o.transfer_account_id is null and i.transfer_account_id is null
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
 * Pick the category for a linked pair: the debt's own payment category when
 * one side is a card or a loan, else "Transfer"; any transfer-class category
 * as fallback, created if the user deleted them all.
 */
async function transferCategoryId(accountA: schema.Account, accountB: schema.Account) {
  const cats = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.spendingClass, "transfer"))
    .orderBy(schema.categories.sortOrder);
  // A card paid from a HELOC is still a card payment, so the card wins when
  // both sides are debts; other debts share "Loan Payment".
  const names = [accountA.accountType, accountB.accountType].map(paymentCategoryName);
  const wanted = names.find((n) => n === "Credit Card Payment") ?? names.find(Boolean);
  const byName = (name: string) =>
    cats.find((c) => !c.isArchived && c.name.toLowerCase() === name.toLowerCase());
  const pick =
    (wanted ? byName(wanted) : undefined) ??
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
  const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await db.transaction(async (tx) => {
    await tx.update(schema.transactions)
      .set({ transferPeerId: b.id, categoryId, categorySource: source })
      .where(eq(schema.transactions.id, a.id))
      .run();
    await tx.update(schema.transactions)
      .set({ transferPeerId: a.id, categoryId, categorySource: source })
      .where(eq(schema.transactions.id, b.id))
      .run();
    // A pair the user links by hand is no longer a dismissed suggestion —
    // otherwise unlinking later would leave it permanently un-suggestable.
    if (source === "user") {
      await tx.delete(schema.transferRejections)
        .where(
          and(
            eq(schema.transferRejections.txnAId, lo),
            eq(schema.transferRejections.txnBId, hi),
          ),
        )
        .run();
    }
  });
  return null;
}

export interface TransferTargetAccount {
  id: number;
  name: string;
  institution: string;
  accountType: schema.Account["accountType"];
}

async function activeAccountsOfKind(
  kind: schema.Account["kind"],
): Promise<TransferTargetAccount[]> {
  return db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      institution: schema.accounts.institution,
      accountType: schema.accounts.accountType,
    })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.kind, kind), eq(schema.accounts.isActive, true)))
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);
}

/**
 * Balance-only accounts a transaction can name as its far side. These keep no
 * ledger of their own, so a transfer into or out of one never has a second row
 * to pair with — the link points at the account instead.
 */
export async function balanceTransferTargets() {
  return activeAccountsOfKind("balance");
}

/**
 * Accounts that keep their own transactions, minus the one this row lives in.
 * The far side here is a *row*, not the account: naming the account instead
 * would count the movement twice, since `reconcileAccounts` folds every
 * `transferAccountId` leg in as a contribution to the account it names.
 */
export async function pairTransferTargets(excludeAccountId: number) {
  const accounts = await activeAccountsOfKind("transaction");
  return accounts.filter((a) => a.id !== excludeAccountId);
}

/**
 * How far out a hand-made pair search looks. Wider than `TRANSFER_WINDOW_DAYS`
 * because the automatic window guards a guess, while this one only decides
 * which rows are worth showing a user who is naming the far side themselves.
 */
export const MANUAL_TRANSFER_WINDOW_DAYS = 60;

/** Cap per account — a round amount like -20.00 can match a great many rows. */
const MANUAL_CANDIDATES_PER_ACCOUNT = 25;

export interface ManualPeerCandidate extends TransferLeg {
  /** What this row is filed as today; linking overwrites it. */
  categoryName: string | null;
  dayDiff: number;
}

/**
 * Rows in other transaction-keeping accounts that could be this one's opposite
 * leg, for the manual picker. Deliberately looser than `rawCandidatePairs`:
 * the wide window, and no filter on the row's current category or on past
 * dismissals — a user pointing at a specific row is overriding all three of
 * those guesses. Equal-and-opposite stays, because `linkTransferPair` drops
 * both legs out of reporting and mismatched legs would lose the difference.
 */
export async function manualPeerCandidates(
  txnId: number,
): Promise<ManualPeerCandidate[]> {
  const rows = await db.all<{
    id: number;
    date: string;
    amount_cents: number;
    description: string;
    account_id: number;
    account_name: string;
    category_name: string | null;
    day_diff: number;
  }>(sql`
    select * from (
      select t.id, t.date, t.amount_cents, t.description,
             t.account_id, a.name as account_name, c.name as category_name,
             abs(julianday(t.date) - julianday(s.date)) as day_diff,
             row_number() over (
               partition by t.account_id
               order by abs(julianday(t.date) - julianday(s.date)) asc, t.id desc
             ) as rn
      from transactions t
      join transactions s on s.id = ${txnId}
      join accounts a on a.id = t.account_id
      left join categories c on c.id = t.category_id
      where t.account_id != s.account_id
        and t.amount_cents = -s.amount_cents
        and t.transfer_peer_id is null
        and t.transfer_account_id is null
        and a.kind = 'transaction'
        and a.is_active = 1
        and abs(julianday(t.date) - julianday(s.date)) <= ${MANUAL_TRANSFER_WINDOW_DAYS}
    )
    where rn <= ${MANUAL_CANDIDATES_PER_ACCOUNT}
    order by day_diff asc, date desc, id desc
  `);
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    amountCents: r.amount_cents,
    description: r.description,
    accountId: r.account_id,
    accountName: r.account_name,
    categoryName: r.category_name,
    dayDiff: Math.round(r.day_diff),
  }));
}

/**
 * Record that this transaction's far side is a balance-only account: a
 * brokerage contribution, a 401k deferral, a mortgage payment. The row gets a
 * transfer-class category exactly as a linked pair would, so it leaves
 * income/spend reporting, and `reconcileAccounts` can then tell the target's
 * contributions apart from its market movement.
 *
 * Returns an error string, or null on success.
 */
export async function linkTransferToAccount(
  txnId: number,
  accountId: number,
  source: "user" | "auto" | "ai",
): Promise<string | null> {
  const txn = await db.query.transactions.findFirst({
    where: eq(schema.transactions.id, txnId),
    with: { account: true },
  });
  if (!txn) return "Transaction not found";
  if (txn.transferPeerId != null)
    return "This is already linked to an opposite leg — unlink that first";

  const target = await db.query.accounts.findFirst({
    where: eq(schema.accounts.id, accountId),
  });
  if (!target) return "Account not found";
  if (target.id === txn.accountId)
    return "That is the account this transaction is already in";
  if (target.kind !== "balance")
    return `${target.name} keeps its own transactions — link the two legs instead`;

  const categoryId = await transferCategoryId(txn.account, target);
  await db
    .update(schema.transactions)
    .set({ transferAccountId: target.id, categoryId, categorySource: source })
    .where(eq(schema.transactions.id, txnId));
  return null;
}

/** Undo an account link. The category is left alone, as with pair unlinking. */
export async function unlinkTransferAccount(txnId: number) {
  await db
    .update(schema.transactions)
    .set({ transferAccountId: null })
    .where(eq(schema.transactions.id, txnId));
}

export interface AccountLinkedTransfer extends TransferLeg {
  targetAccountId: number;
  targetAccountName: string;
}

/** Legs whose far side is a balance-only account, newest first. */
export async function accountLinkedTransfers(
  limit = 30,
): Promise<AccountLinkedTransfer[]> {
  // Two different accounts per row — the one holding the transaction and the
  // one it points at — so the far side needs its own alias.
  const target = alias(schema.accounts, "target_account");
  return db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      description: schema.transactions.description,
      accountId: schema.transactions.accountId,
      accountName: schema.accounts.name,
      targetAccountId: target.id,
      targetAccountName: target.name,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.transactions.accountId),
    )
    .innerJoin(target, eq(target.id, schema.transactions.transferAccountId))
    .orderBy(desc(schema.transactions.date), desc(schema.transactions.id))
    .limit(limit);
}

/** Undo a pair link. Categories are left alone. Returns the peer id, if any. */
export async function unlinkTransfer(txnId: number): Promise<number | null> {
  const txn = await db.query.transactions.findFirst({
    where: eq(schema.transactions.id, txnId),
  });
  if (!txn?.transferPeerId) return null;
  const peerId = txn.transferPeerId;
  await db.transaction(async (tx) => {
    await tx.update(schema.transactions)
      .set({ transferPeerId: null })
      .where(eq(schema.transactions.id, txnId))
      .run();
    await tx.update(schema.transactions)
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

export interface AccountLinkCandidate extends TransferLeg {
  merchant: string;
  targetAccountId: number;
  targetAccountName: string;
  /** Why this account, in the user's words. */
  reason: string;
  /** Clears the bar to be linked without being asked — see below. */
  confident: boolean;
}

/**
 * Legs that look like they belong to a balance-only account.
 *
 * A pair link needs two rows; this needs only one, because the far side keeps
 * no ledger — a 401k deferral, a brokerage contribution, a mortgage payment.
 * `rawCandidatePairs` can never find these (it joins transactions to
 * transactions), so without this they stay hand-made forever.
 *
 * Two ways to be confident enough to link unasked:
 *
 *   - **The description names the account** by its last four or its name, *and*
 *     reads like movement rather than a purchase. The institution branch of
 *     `matchAccountByHint` deliberately does not qualify: "FIDELITY" appears on
 *     a brokerage *fee* as readily as on a contribution, and a wrong link is
 *     worse than none — it drops the row out of income/spend reporting and
 *     `reconcileAccounts` folds it into the target's contributions, which is
 *     what separates market movement from money put in.
 *   - **History already answered.** Every earlier row in this same account with
 *     this same merchant points at one target account. No memory table for
 *     this: the mapping is already in `transactions`, and a query cannot fall
 *     out of step with the rows the way a second store would.
 *
 * Everything else comes back `confident: false` and is offered as a suggestion.
 */
export async function accountLinkCandidates(
  ids?: number[],
): Promise<AccountLinkCandidate[]> {
  const targets = await balanceTransferTargets();
  if (targets.length === 0) return [];

  const scope = ids
    ? sql`and t.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`
    : sql``;

  // The same bar `rawCandidatePairs` sets, minus the pairing join: unlinked,
  // and either unfiled or already filed as a transfer that never found its
  // other half.
  const rows = await db.all<{
    id: number;
    date: string;
    amount_cents: number;
    description: string;
    merchant: string;
    account_id: number;
    account_name: string;
  }>(sql`
    select t.id, t.date, t.amount_cents, t.description, t.merchant,
           t.account_id, a.name as account_name
    from transactions t
    join accounts a on a.id = t.account_id
    where t.transfer_peer_id is null
      and t.transfer_account_id is null
      and t.amount_cents != 0
      and (
        t.category_id is null
        or t.category_id in (select id from categories where spending_class = 'transfer')
      )
      ${scope}
    order by t.date desc, t.id desc
  `);
  if (rows.length === 0) return [];

  // What the same merchant in the same account has been pointed at before.
  const priors = await db.all<{
    account_id: number;
    merchant: string;
    target: number;
  }>(sql`
    select distinct t.account_id, t.merchant, t.transfer_account_id as target
    from transactions t
    where t.transfer_account_id is not null and t.merchant != ''
  `);
  const learned = new Map<string, number | null>();
  for (const p of priors) {
    const key = `${p.account_id}|${p.merchant}`;
    // A merchant that has pointed at two different accounts has not answered
    // anything — null parks the key as ambiguous rather than letting the last
    // row seen win.
    learned.set(key, learned.has(key) ? null : p.target);
  }

  const byId = new Map(targets.map((t) => [t.id, t]));
  const out: AccountLinkCandidate[] = [];
  for (const r of rows) {
    const leg = {
      id: r.id,
      date: r.date,
      amountCents: r.amount_cents,
      description: r.description,
      merchant: r.merchant,
      accountId: r.account_id,
      accountName: r.account_name,
    };

    const remembered = learned.get(`${r.account_id}|${r.merchant}`);
    if (remembered != null && byId.has(remembered)) {
      const target = byId.get(remembered)!;
      out.push({
        ...leg,
        targetAccountId: target.id,
        targetAccountName: target.name,
        reason: `${r.merchant} in this account has gone to ${target.name} before`,
        confident: true,
      });
      continue;
    }

    const hit = matchAccountByHint(targets, r.description);
    if (!hit) continue;
    out.push({
      ...leg,
      targetAccountId: hit.account.id,
      targetAccountName: hit.account.name,
      reason: `Description ${hit.reason}`,
      confident: hit.strength !== "institution" && looksLikeTransfer(r.description),
    });
  }
  return out;
}

/**
 * Point the confident legs at their account. Returns how many were linked.
 *
 * `ids` scopes it to a caller's own rows — the register's bulk categorize runs
 * this per chunk, and without a scope every one of those chunks would re-sweep
 * the whole ledger.
 */
export async function autoLinkAccountTransfers(ids?: number[]): Promise<number> {
  const candidates = await accountLinkCandidates(ids);
  let linked = 0;
  for (const c of candidates) {
    if (!c.confident) continue;
    const err = await linkTransferToAccount(c.id, c.targetAccountId, "auto");
    if (!err) linked++;
  }
  return linked;
}

/** The legs that looked plausible but not certain, for the Transfers screen. */
export async function accountLinkSuggestions(
  limit = 30,
): Promise<AccountLinkCandidate[]> {
  const candidates = await accountLinkCandidates();
  return candidates.filter((c) => !c.confident).slice(0, limit);
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
    where c.spending_class = 'transfer'
      and t.transfer_peer_id is null and t.transfer_account_id is null
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

/**
 * Total moved between own accounts in a date range (outgoing legs). Counts
 * both kinds of link: paired legs, and legs pointed at a balance-only account.
 */
export async function transferVolume(fromDate: string, toDate: string): Promise<number> {
  const [row] = await db.all<{ total: number | null }>(sql`
    select sum(-t.amount_cents) as total
    from transactions t
    where (t.transfer_peer_id is not null or t.transfer_account_id is not null)
      and t.amount_cents < 0
      and t.date >= ${fromDate} and t.date <= ${toDate}
  `);
  return row?.total ?? 0;
}
