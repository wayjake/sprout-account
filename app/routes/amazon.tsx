import { Form, Link, data, useFetcher, useNavigation } from "react-router";
import { and, desc, eq, isNull, like, lt, notInArray, or, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { importOrderHistoryCsv, runMatcher } from "~/.server/amazon";
import { Amount, Button, Card, CardHeader, EmptyState } from "~/components/ui";
import { formatDate } from "~/lib/dates";
import { formatCents } from "~/lib/money";
import type { Route } from "./+types/amazon";

export function meta() {
  return [{ title: "The Endless Bazaar · Sprout Account 2000" }];
}

export async function loader(_: Route.LoaderArgs) {
  const [orderCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.amazonOrders);
  const confirmedOrderIds = db
    .select({ id: schema.amazonMatches.orderId })
    .from(schema.amazonMatches)
    .where(eq(schema.amazonMatches.status, "confirmed"));
  const confirmedTxnIds = db
    .select({ id: schema.amazonMatches.transactionId })
    .from(schema.amazonMatches)
    .where(eq(schema.amazonMatches.status, "confirmed"));

  const suggested = await db.query.amazonMatches.findMany({
    where: eq(schema.amazonMatches.status, "suggested"),
    with: {
      order: { with: { items: true } },
      transaction: true,
    },
    limit: 30,
  });

  const unmatchedOrders = await db.query.amazonOrders.findMany({
    where: notInArray(schema.amazonOrders.id, confirmedOrderIds),
    with: { items: true },
    orderBy: desc(schema.amazonOrders.orderDate),
    limit: 25,
  });

  const unmatchedTxns = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        or(
          like(schema.transactions.merchant, "%AMAZON%"),
          like(schema.transactions.merchant, "%AMZN%"),
        ),
        lt(schema.transactions.amountCents, 0),
        notInArray(schema.transactions.id, confirmedTxnIds),
      ),
    )
    .orderBy(desc(schema.transactions.date))
    .limit(25);

  const recentConfirmed = await db.query.amazonMatches.findMany({
    where: eq(schema.amazonMatches.status, "confirmed"),
    with: { order: true, transaction: true },
    orderBy: desc(schema.amazonMatches.id),
    limit: 15,
  });

  const [matchedCount] = await db
    .select({ count: sql<number>`count(distinct ${schema.amazonMatches.orderId})` })
    .from(schema.amazonMatches)
    .where(eq(schema.amazonMatches.status, "confirmed"));

  return {
    orderCount: orderCount.count,
    matchedCount: matchedCount.count,
    suggested,
    unmatchedOrders,
    unmatchedTxns,
    recentConfirmed,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return data({ error: "Choose an order-history CSV." }, { status: 400 });
    }
    const result = await importOrderHistoryCsv(
      Buffer.from(await file.arrayBuffer()).toString("utf-8"),
      file.name,
    );
    if ("error" in result) return data({ error: result.error }, { status: 400 });
    const matchStats = await runMatcher();
    return { uploaded: result, matchStats };
  }

  if (intent === "run-matcher") {
    return { matchStats: await runMatcher() };
  }

  if (intent === "confirm" || intent === "reject") {
    const id = Number(form.get("matchId"));
    await db
      .update(schema.amazonMatches)
      .set({ status: intent === "confirm" ? "confirmed" : "rejected" })
      .where(eq(schema.amazonMatches.id, id));
    return { ok: true };
  }

  if (intent === "undo") {
    const id = Number(form.get("matchId"));
    await db.delete(schema.amazonMatches).where(eq(schema.amazonMatches.id, id));
    return { ok: true };
  }

  if (intent === "manual-match") {
    const transactionId = Number(form.get("transactionId"));
    const orderId = Number(form.get("orderId"));
    if (!transactionId || !orderId) {
      return data({ error: "Pick both a charge and an order." }, { status: 400 });
    }
    const txn = await db.query.transactions.findFirst({
      where: eq(schema.transactions.id, transactionId),
    });
    if (!txn) return data({ error: "Transaction not found" }, { status: 404 });
    await db
      .insert(schema.amazonMatches)
      .values({
        transactionId,
        orderId,
        amountCents: txn.amountCents,
        matchType: "manual",
        status: "confirmed",
        confidence: 1,
      })
      .onConflictDoUpdate({
        target: [schema.amazonMatches.transactionId, schema.amazonMatches.orderId],
        set: { status: "confirmed", matchType: "manual" },
      });
    return { ok: true };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

export default function Amazon({ loaderData, actionData }: Route.ComponentProps) {
  const {
    orderCount,
    matchedCount,
    suggested,
    unmatchedOrders,
    unmatchedTxns,
    recentConfirmed,
  } = loaderData;
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-[16px] font-bold text-primary-950">📦 The Endless Bazaar</h1>
        <p className="mt-1 text-sm text-gray-500">
          Import your Amazon order history (Account → Request Your Data → Your Orders),
          and Sprout matches orders to card charges — including split shipments and
          combined charges. {orderCount > 0 && (
            <>
              <span className="font-medium text-primary-800">{matchedCount}</span> of{" "}
              <span className="font-medium text-primary-800">{orderCount}</span> orders
              matched.
            </>
          )}
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}
      {actionData && "uploaded" in actionData && actionData.uploaded && (
        <p className="groove bg-[#eef7ee] px-3 py-1.5 text-[12px] text-primary-900">
          Imported {actionData.uploaded.ordersAdded} orders (
          {actionData.uploaded.itemsAdded} items
          {actionData.uploaded.ordersSkipped > 0 &&
            `, ${actionData.uploaded.ordersSkipped} already known`}
          ).{" "}
          {"matchStats" in actionData &&
            actionData.matchStats &&
            `Matcher: ${actionData.matchStats.confirmed} auto-confirmed, ${actionData.matchStats.suggested} suggestions.`}
        </p>
      )}
      {actionData &&
        "matchStats" in actionData &&
        actionData.matchStats &&
        !("uploaded" in actionData && actionData.uploaded) && (
          <p className="groove bg-[#eef7ee] px-3 py-1.5 text-[12px] text-primary-900">
            Matcher run: {actionData.matchStats.confirmed} auto-confirmed,{" "}
            {actionData.matchStats.suggested} suggestions,{" "}
            {actionData.matchStats.unmatchedOrders} orders and{" "}
            {actionData.matchStats.unmatchedTxns} charges still unmatched.
          </p>
        )}

      <div className="flex items-end gap-3">
        <Card className="flex-1">
          <Form method="post" encType="multipart/form-data" className="flex items-center gap-3 p-4">
            <input type="hidden" name="intent" value="upload" />
            <input
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="block flex-1 text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary-800 hover:file:bg-primary-200"
            />
            <Button type="submit" disabled={busy}>
              {busy ? "Importing…" : "Import orders"}
            </Button>
            <Button name="intent" value="run-matcher" variant="secondary" disabled={busy} formNoValidate>
              Re-run matcher
            </Button>
          </Form>
        </Card>
      </div>

      {suggested.length > 0 && (
        <Card>
          <CardHeader title={`Needs review (${suggested.length})`} />
          <ul className="divide-y divide-primary-50">
            {suggested.map((m) => (
              <li key={m.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                <div className="flex-1">
                  <p className="font-medium text-gray-900">
                    {formatDate(m.transaction.date)} · {m.transaction.description} ·{" "}
                    <Amount cents={m.transaction.amountCents} />
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    Order {m.order.orderId} ({formatDate(m.order.orderDate)},{" "}
                    {formatCents(m.order.totalCents)}):{" "}
                    {m.order.items.map((i) => i.description).join("; ").slice(0, 120)}
                  </p>
                </div>
                <fetcher.Form method="post" className="flex gap-1.5">
                  <input type="hidden" name="matchId" value={m.id} />
                  <Button name="intent" value="confirm" size="sm" variant="secondary">
                    Confirm
                  </Button>
                  <Button name="intent" value="reject" size="sm" variant="ghost">
                    Reject
                  </Button>
                </fetcher.Form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-5">
        <Card>
          <CardHeader title={`Unmatched orders (${unmatchedOrders.length})`} />
          {unmatchedOrders.length === 0 ? (
            <div className="p-4">
              <EmptyState title={orderCount === 0 ? "No orders imported yet" : "All orders matched 🎉"} />
            </div>
          ) : (
            <ul className="max-h-96 divide-y divide-primary-50 overflow-y-auto">
              {unmatchedOrders.map((o) => (
                <li key={o.id} className="px-4 py-2.5 text-sm">
                  <p className="flex items-center justify-between font-medium text-gray-900">
                    <span>{formatDate(o.orderDate)}</span>
                    <span className="tabular-nums">{formatCents(o.totalCents)}</span>
                  </p>
                  <p className="truncate text-xs text-gray-500" title={o.items.map((i) => i.description).join("; ")}>
                    {o.items.map((i) => i.description).join("; ") || o.orderId}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={`Unmatched Amazon charges (${unmatchedTxns.length})`} />
          {unmatchedTxns.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No unmatched charges" />
            </div>
          ) : (
            <ul className="max-h-96 divide-y divide-primary-50 overflow-y-auto">
              {unmatchedTxns.map((t) => (
                <li key={t.id} className="px-4 py-2.5 text-sm">
                  <p className="flex items-center justify-between">
                    <Link to={`/transactions/${t.id}`} className="font-medium text-gray-900 hover:text-primary-700">
                      {formatDate(t.date)} · {t.description}
                    </Link>
                    <Amount cents={t.amountCents} />
                  </p>
                  {unmatchedOrders.length > 0 && (
                    <fetcher.Form method="post" className="mt-1 flex items-center gap-1.5">
                      <input type="hidden" name="intent" value="manual-match" />
                      <input type="hidden" name="transactionId" value={t.id} />
                      <select
                        name="orderId"
                        className="flex-1 rounded-md border border-primary-200 bg-white px-1.5 py-1 text-xs"
                        defaultValue=""
                      >
                        <option value="">Match to order…</option>
                        {unmatchedOrders.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.orderDate} · {formatCents(o.totalCents)} ·{" "}
                            {(o.items[0]?.description ?? o.orderId).slice(0, 40)}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" variant="ghost" type="submit">
                        Link
                      </Button>
                    </fetcher.Form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {recentConfirmed.length > 0 && (
        <Card>
          <CardHeader title="Recently matched" />
          <ul className="divide-y divide-primary-50">
            {recentConfirmed.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="text-xs text-gray-400">
                  {m.matchType === "auto" ? `auto ${Math.round((m.confidence ?? 0) * 100)}%` : "manual"}
                </span>
                <Link
                  to={`/transactions/${m.transactionId}`}
                  className="flex-1 truncate font-medium text-gray-900 hover:text-primary-700"
                >
                  {formatDate(m.transaction.date)} · {m.transaction.description}
                </Link>
                <span className="text-xs text-gray-500">
                  order {formatDate(m.order.orderDate)} · {formatCents(m.order.totalCents)}
                </span>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="undo" />
                  <input type="hidden" name="matchId" value={m.id} />
                  <Button size="sm" variant="ghost" type="submit">
                    Undo
                  </Button>
                </fetcher.Form>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
