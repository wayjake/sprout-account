import { and, eq, inArray, like, lt, notInArray, or, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { parseCsv } from "~/.server/import/csv";
import { createBatch, sha256 } from "~/.server/import/stage";
import { addDays } from "~/lib/dates";
import { parseCentsString } from "~/lib/money";

// --- order history CSV ingestion ---

/** Header aliases across Amazon export vintages (Privacy Central "Retail.OrderHistory",
 *  older order reports, and common browser-extension exports). */
const HEADER_ALIASES: Record<string, string[]> = {
  orderId: ["order id", "order number", "order #"],
  orderDate: ["order date", "date"],
  productName: ["product name", "title", "item name", "description"],
  asin: ["asin", "asin/isbn"],
  quantity: ["quantity", "qty"],
  itemTotal: ["total owed", "item total", "total charged", "item subtotal plus tax", "total"],
};

function resolveHeaders(headers: string[]): Record<string, string> | null {
  const lower = new Map(headers.map((h) => [h.toLowerCase().trim(), h]));
  const resolved: Record<string, string> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const hit = lower.get(alias);
      if (hit) {
        resolved[key] = hit;
        break;
      }
    }
  }
  return resolved.orderId && resolved.orderDate && resolved.itemTotal
    ? resolved
    : null;
}

function parseAmazonDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return `${y}-${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  }
  return null;
}

export interface AmazonImportStats {
  ordersAdded: number;
  ordersSkipped: number;
  itemsAdded: number;
  rowErrors: number;
}

export async function importOrderHistoryCsv(
  text: string,
  filename: string,
): Promise<AmazonImportStats | { error: string }> {
  const { headers, records } = parseCsv(text);
  const cols = resolveHeaders(headers);
  if (!cols) {
    return {
      error: `Unrecognized Amazon export — headers found: ${headers.join(", ")}. Expected at least Order ID, Order Date, and an item total column.`,
    };
  }

  interface Item {
    description: string;
    quantity: number;
    totalCents: number;
    asin: string | null;
  }
  const orders = new Map<string, { orderDate: string; items: Item[] }>();
  let rowErrors = 0;

  for (const rec of records) {
    const orderId = (rec[cols.orderId] ?? "").trim();
    const date = parseAmazonDate(rec[cols.orderDate] ?? "");
    const totalCents = parseCentsString(rec[cols.itemTotal] ?? "");
    if (!orderId || !date || totalCents == null) {
      rowErrors++;
      continue;
    }
    if (!orders.has(orderId)) orders.set(orderId, { orderDate: date, items: [] });
    orders.get(orderId)!.items.push({
      description: (rec[cols.productName ?? ""] ?? "").trim() || "(unknown item)",
      quantity: Number(rec[cols.quantity ?? ""] ?? "1") || 1,
      totalCents: Math.abs(totalCents),
      asin: (rec[cols.asin ?? ""] ?? "").trim() || null,
    });
  }
  if (orders.size === 0) return { error: "No orders could be parsed from this file." };

  const orderDates = [...orders.values()].map((o) => o.orderDate).sort();
  const batch = await createBatch({
    accountId: null,
    accountLabel: "Amazon order history",
    kind: "amazon_orders",
    sourceType: "csv",
    filename,
    fileHash: sha256(text),
    status: "committed",
    periodStart: orderDates[0],
    periodEnd: orderDates[orderDates.length - 1],
    rowCount: orders.size,
  });

  const stats: AmazonImportStats = {
    ordersAdded: 0,
    ordersSkipped: 0,
    itemsAdded: 0,
    rowErrors,
  };
  for (const [orderId, o] of orders) {
    const total = o.items.reduce((a, i) => a + i.totalCents, 0);
    const inserted = await db
      .insert(schema.amazonOrders)
      .values({
        orderId,
        orderDate: o.orderDate,
        totalCents: total,
        importBatchId: batch.id,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      stats.ordersSkipped++;
      continue;
    }
    stats.ordersAdded++;
    for (const item of o.items) {
      await db.insert(schema.amazonOrderItems).values({
        orderId: inserted[0].id,
        ...item,
      });
      stats.itemsAdded++;
    }
  }
  await db
    .update(schema.importBatches)
    .set({ statsJson: JSON.stringify(stats) })
    .where(eq(schema.importBatches.id, batch.id));
  return stats;
}

// --- matching ---

const WINDOW_DAYS = 7;
const MAX_SUBSET_POOL = 12;

interface OrderLite {
  id: number;
  orderId: string;
  orderDate: string;
  totalCents: number;
}
interface TxnLite {
  id: number;
  date: string;
  amountCents: number;
}

/** All k-subsets (k ≤ maxSize) of pool summing to target. Stops early once two are found. */
function subsetsSummingTo<T>(
  pool: T[],
  value: (t: T) => number,
  target: number,
  maxSize: number,
): T[][] {
  const found: T[][] = [];
  const pick: T[] = [];
  const walk = (start: number, remaining: number) => {
    if (found.length >= 2) return;
    if (remaining === 0 && pick.length >= 2) {
      found.push([...pick]);
      return;
    }
    if (pick.length >= maxSize) return;
    for (let i = start; i < pool.length; i++) {
      const v = value(pool[i]);
      if (v > remaining) continue;
      pick.push(pool[i]);
      walk(i + 1, remaining - v);
      pick.pop();
      if (found.length >= 2) return;
    }
  };
  walk(0, target);
  return found;
}

export interface MatchRunStats {
  confirmed: number;
  suggested: number;
  unmatchedOrders: number;
  unmatchedTxns: number;
}

/**
 * Three-pass matcher:
 *  1. exact 1:1 amount within the charge window
 *  2. split shipments — one order charged as ≤4 partial amounts
 *  3. combined charges — ≤3 orders charged as one amount
 * Unique solutions auto-confirm; ambiguous ones become suggestions.
 */
export async function runMatcher(): Promise<MatchRunStats> {
  // Wipe stale suggestions from previous runs; keep confirmed/rejected decisions.
  await db.delete(schema.amazonMatches).where(eq(schema.amazonMatches.status, "suggested"));

  const matchedOrderIds = (
    await db
      .select({ orderId: schema.amazonMatches.orderId })
      .from(schema.amazonMatches)
      .where(eq(schema.amazonMatches.status, "confirmed"))
  ).map((r) => r.orderId);
  const matchedTxnIds = (
    await db
      .select({ transactionId: schema.amazonMatches.transactionId })
      .from(schema.amazonMatches)
      .where(eq(schema.amazonMatches.status, "confirmed"))
  ).map((r) => r.transactionId);

  const orders: OrderLite[] = await db
    .select({
      id: schema.amazonOrders.id,
      orderId: schema.amazonOrders.orderId,
      orderDate: schema.amazonOrders.orderDate,
      totalCents: schema.amazonOrders.totalCents,
    })
    .from(schema.amazonOrders)
    .where(
      and(
        sql`${schema.amazonOrders.totalCents} > 0`,
        matchedOrderIds.length
          ? notInArray(schema.amazonOrders.id, matchedOrderIds)
          : undefined,
      ),
    );

  const txns: TxnLite[] = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
    })
    .from(schema.transactions)
    .where(
      and(
        or(
          like(schema.transactions.merchant, "%AMAZON%"),
          like(schema.transactions.merchant, "%AMZN%"),
        ),
        lt(schema.transactions.amountCents, 0),
        matchedTxnIds.length
          ? notInArray(schema.transactions.id, matchedTxnIds)
          : undefined,
      ),
    );

  const stats: MatchRunStats = {
    confirmed: 0,
    suggested: 0,
    unmatchedOrders: 0,
    unmatchedTxns: 0,
  };
  const usedTxns = new Set<number>();
  const usedOrders = new Set<number>();
  const suggestions: {
    transactionId: number;
    orderId: number;
    amountCents: number;
    confidence: number;
  }[] = [];

  const inWindow = (o: OrderLite, t: TxnLite) =>
    t.date >= o.orderDate && t.date <= addDays(o.orderDate, WINDOW_DAYS);

  const confirm = async (
    transactionId: number,
    orderId: number,
    amountCents: number,
    confidence: number,
  ) => {
    await db
      .insert(schema.amazonMatches)
      .values({
        transactionId,
        orderId,
        amountCents,
        matchType: "auto",
        status: "confirmed",
        confidence,
      })
      .onConflictDoNothing();
    stats.confirmed++;
  };

  // Pass 1 — exact 1:1
  for (const order of orders) {
    if (usedOrders.has(order.id)) continue;
    const candidates = txns.filter(
      (t) =>
        !usedTxns.has(t.id) &&
        Math.abs(t.amountCents) === order.totalCents &&
        inWindow(order, t),
    );
    if (candidates.length === 1) {
      const txn = candidates[0];
      // The txn must not equally match a different unmatched order
      const rivalOrders = orders.filter(
        (o) =>
          o.id !== order.id &&
          !usedOrders.has(o.id) &&
          o.totalCents === Math.abs(txn.amountCents) &&
          inWindow(o, txn),
      );
      if (rivalOrders.length === 0) {
        await confirm(txn.id, order.id, txn.amountCents, 1.0);
        usedTxns.add(txn.id);
        usedOrders.add(order.id);
        continue;
      }
    }
    for (const c of candidates) {
      suggestions.push({
        transactionId: c.id,
        orderId: order.id,
        amountCents: c.amountCents,
        confidence: 0.5,
      });
    }
  }

  // Pass 2 — split shipments: one order, several charges
  for (const order of orders) {
    if (usedOrders.has(order.id)) continue;
    const pool = txns
      .filter((t) => !usedTxns.has(t.id) && inWindow(order, t))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, MAX_SUBSET_POOL);
    const subsets = subsetsSummingTo(
      pool,
      (t) => Math.abs(t.amountCents),
      order.totalCents,
      4,
    );
    if (subsets.length === 1) {
      for (const t of subsets[0]) {
        await confirm(t.id, order.id, t.amountCents, 0.9);
        usedTxns.add(t.id);
      }
      usedOrders.add(order.id);
    } else if (subsets.length > 1) {
      for (const t of subsets[0]) {
        suggestions.push({
          transactionId: t.id,
          orderId: order.id,
          amountCents: t.amountCents,
          confidence: 0.4,
        });
      }
    }
  }

  // Pass 3 — combined charge: several orders, one charge
  for (const txn of txns) {
    if (usedTxns.has(txn.id)) continue;
    const pool = orders
      .filter(
        (o) =>
          !usedOrders.has(o.id) &&
          o.orderDate <= txn.date &&
          o.orderDate >= addDays(txn.date, -WINDOW_DAYS),
      )
      .slice(0, MAX_SUBSET_POOL);
    const subsets = subsetsSummingTo(
      pool,
      (o) => o.totalCents,
      Math.abs(txn.amountCents),
      3,
    );
    if (subsets.length === 1) {
      for (const o of subsets[0]) {
        await confirm(txn.id, o.id, -o.totalCents, 0.85);
        usedOrders.add(o.id);
      }
      usedTxns.add(txn.id);
    } else if (subsets.length > 1) {
      for (const o of subsets[0]) {
        suggestions.push({
          transactionId: txn.id,
          orderId: o.id,
          amountCents: -o.totalCents,
          confidence: 0.4,
        });
      }
    }
  }

  // Persist deduped suggestions for pairs not already decided
  const seen = new Set<string>();
  for (const s of suggestions) {
    if (usedTxns.has(s.transactionId) || usedOrders.has(s.orderId)) continue;
    const key = `${s.transactionId}|${s.orderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = await db
      .select({ id: schema.amazonMatches.id })
      .from(schema.amazonMatches)
      .where(
        and(
          eq(schema.amazonMatches.transactionId, s.transactionId),
          eq(schema.amazonMatches.orderId, s.orderId),
        ),
      );
    if (existing.length > 0) continue; // previously rejected or confirmed
    await db.insert(schema.amazonMatches).values({
      ...s,
      matchType: "auto",
      status: "suggested",
    });
    stats.suggested++;
  }

  stats.unmatchedOrders = orders.filter((o) => !usedOrders.has(o.id)).length;
  stats.unmatchedTxns = txns.filter((t) => !usedTxns.has(t.id)).length;
  return stats;
}

// --- item splits ---

/**
 * Turn a matched transaction's order items into transaction splits,
 * pro-rating so the split cents sum exactly to the transaction amount
 * (largest-remainder rounding).
 */
export async function applyItemSplits(transactionId: number): Promise<string | null> {
  const txn = await db.query.transactions.findFirst({
    where: eq(schema.transactions.id, transactionId),
    with: {
      amazonMatches: {
        where: eq(schema.amazonMatches.status, "confirmed"),
        with: { order: { with: { items: true } } },
      },
    },
  });
  if (!txn) return "Transaction not found";
  if (txn.amazonMatches.length === 0) return "No confirmed Amazon match";

  // Items covered by this transaction, scaled by the matched portion of each order
  const weighted: { item: (typeof txn.amazonMatches)[number]["order"]["items"][number]; weight: number }[] = [];
  for (const m of txn.amazonMatches) {
    const orderItems = m.order.items;
    const orderItemTotal = orderItems.reduce((a, i) => a + i.totalCents, 0);
    if (orderItemTotal === 0) continue;
    const portion = Math.abs(m.amountCents) / m.order.totalCents;
    for (const item of orderItems) {
      weighted.push({ item, weight: item.totalCents * portion });
    }
  }
  if (weighted.length === 0) return "Matched orders have no items";
  if (weighted.length === 1) return "Only one item — a split isn't needed";

  const totalWeight = weighted.reduce((a, w) => a + w.weight, 0);
  const target = txn.amountCents; // negative
  const raw = weighted.map((w) => (w.weight / totalWeight) * target);
  const floored = raw.map((r) => Math.trunc(r));
  let leftover = target - floored.reduce((a, b) => a + b, 0);
  // Distribute remaining cents to the largest fractional remainders
  const order = raw
    .map((r, i) => ({ i, frac: Math.abs(r - Math.trunc(r)) }))
    .sort((a, b) => b.frac - a.frac);
  const amounts = [...floored];
  const step = leftover > 0 ? 1 : -1;
  for (let k = 0; leftover !== 0 && k < order.length * 2; k++) {
    amounts[order[k % order.length].i] += step;
    leftover -= step;
  }

  const fallback = await db.query.categories.findFirst({
    where: eq(schema.categories.name, "Shopping"),
  });
  const rows = weighted
    .map((w, i) => ({
      transactionId,
      categoryId: w.item.categoryId ?? txn.categoryId ?? fallback?.id ?? null,
      amountCents: amounts[i],
      memo: w.item.description.slice(0, 80),
    }))
    .filter((r) => r.amountCents !== 0);
  if (rows.some((r) => r.categoryId == null)) {
    return "Assign categories to the order items first (or categorize the transaction).";
  }

  db.transaction((tx) => {
    tx.delete(schema.transactionSplits)
      .where(eq(schema.transactionSplits.transactionId, transactionId))
      .run();
    tx.insert(schema.transactionSplits)
      .values(rows as (typeof schema.transactionSplits.$inferInsert)[])
      .run();
  });
  return null;
}
