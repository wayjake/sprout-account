import { useState } from "react";
import { Form, Link, data, redirect, useFetcher, useRouteLoaderData } from "react-router";
import type { Category } from "~/db/schema";
import { eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { applyItemSplits } from "~/.server/amazon";
import { recordUserChoice } from "~/.server/categorize";
import {
  findCandidatesFor,
  linkTransferPair,
  unlinkTransfer,
} from "~/.server/transfers";
import { CategoryOptions } from "~/components/category-picker";
import {
  Amount,
  Button,
  Card,
  CardHeader,
  ClassBadge,
  Field,
  inputClass,
  selectClass,
} from "~/components/ui";
import { formatDate } from "~/lib/dates";
import { centsToInput, formatCents, parseCentsInput } from "~/lib/money";
import type { loader as shellLoader } from "./shell";
import type { Route } from "./+types/transaction-detail";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: `${loaderData?.transaction.merchant ?? "Transaction"} · Sprout Account 2000` },
  ];
}

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const transaction = await db.query.transactions.findFirst({
    where: eq(schema.transactions.id, id),
    with: {
      account: true,
      category: true,
      transferPeer: { with: { account: true } },
      splits: { with: { category: true } },
      amazonMatches: {
        with: { order: { with: { items: { with: { category: true } } } } },
      },
    },
  });
  if (!transaction) throw data("Transaction not found", { status: 404 });
  const transferCandidates = transaction.transferPeerId
    ? []
    : await findCandidatesFor(id);
  return { transaction, transferCandidates };
}

export async function action({ params, request }: Route.ActionArgs) {
  const id = Number(params.id);
  const form = await request.formData();
  const intent = form.get("intent");

  const [txn] = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id))
    .limit(1);
  if (!txn) throw data("Transaction not found", { status: 404 });

  if (intent === "update") {
    const date = String(form.get("date") ?? txn.date);
    const amountCents = parseCentsInput(String(form.get("amount") ?? ""));
    const notes = String(form.get("notes") ?? "").trim() || null;
    const categoryId = form.get("categoryId")
      ? Number(form.get("categoryId"))
      : null;
    if (amountCents == null) {
      return data({ error: "Invalid amount" }, { status: 400 });
    }
    await db
      .update(schema.transactions)
      .set({
        date,
        amountCents,
        notes,
        categoryId,
        categorySource:
          categoryId == null
            ? null
            : categoryId !== txn.categoryId
              ? "user"
              : txn.categorySource,
      })
      .where(eq(schema.transactions.id, id));
    if (categoryId && categoryId !== txn.categoryId) {
      await recordUserChoice(txn.merchant, categoryId);
    }
    return { ok: true };
  }

  if (intent === "save-splits") {
    const categoryIds = form.getAll("splitCategoryId").map(Number);
    const amounts = form.getAll("splitAmount").map((v) => parseCentsInput(String(v)));
    const memos = form.getAll("splitMemo").map((v) => String(v));
    const rows = categoryIds
      .map((categoryId, i) => ({
        transactionId: id,
        categoryId,
        amountCents: amounts[i]!,
        memo: memos[i]?.trim() || null,
      }))
      .filter((r) => r.categoryId && r.amountCents != null && r.amountCents !== 0);
    if (rows.length < 2) {
      return data({ error: "A split needs at least two lines" }, { status: 400 });
    }
    const sum = rows.reduce((acc, r) => acc + r.amountCents!, 0);
    if (sum !== txn.amountCents) {
      return data(
        {
          error: `Split lines total ${formatCents(sum)} but the transaction is ${formatCents(
            txn.amountCents,
          )}. They must match exactly.`,
        },
        { status: 400 },
      );
    }
    db.transaction((tx) => {
      tx.delete(schema.transactionSplits)
        .where(eq(schema.transactionSplits.transactionId, id))
        .run();
      tx.insert(schema.transactionSplits)
        .values(rows as (typeof schema.transactionSplits.$inferInsert)[])
        .run();
    });
    return { ok: true };
  }

  if (intent === "clear-splits") {
    await db
      .delete(schema.transactionSplits)
      .where(eq(schema.transactionSplits.transactionId, id));
    return { ok: true };
  }

  if (intent === "set-item-category") {
    const itemId = Number(form.get("itemId"));
    const categoryId = form.get("categoryId") ? Number(form.get("categoryId")) : null;
    await db
      .update(schema.amazonOrderItems)
      .set({ categoryId })
      .where(eq(schema.amazonOrderItems.id, itemId));
    return { ok: true };
  }

  if (intent === "apply-item-splits") {
    const error = await applyItemSplits(id);
    if (error) return data({ error }, { status: 400 });
    return { ok: true };
  }

  if (intent === "link-transfer") {
    const peerId = Number(form.get("peerId"));
    const [outId, inId] = txn.amountCents < 0 ? [id, peerId] : [peerId, id];
    const error = await linkTransferPair(outId, inId, "user");
    if (error) return data({ error }, { status: 400 });
    return { ok: true };
  }

  if (intent === "unlink-transfer") {
    await unlinkTransfer(id);
    return { ok: true };
  }

  if (intent === "delete") {
    // db:push created transfer_peer_id without its FK (SQLite can't add one
    // in-place), so clear the surviving leg's pointer ourselves.
    await db
      .update(schema.transactions)
      .set({ transferPeerId: null })
      .where(eq(schema.transactions.transferPeerId, id));
    await db.delete(schema.transactions).where(eq(schema.transactions.id, id));
    return redirect("/transactions");
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

function ItemSplitButton() {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="apply-item-splits" />
      <Button size="sm" variant="secondary" type="submit" disabled={fetcher.state !== "idle"}>
        {fetcher.state !== "idle" ? "Splitting…" : "Apply items as splits"}
      </Button>
    </fetcher.Form>
  );
}

function ItemCategoryPicker({
  item,
  categories,
}: {
  item: { id: number; categoryId: number | null };
  categories: Category[];
}) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="set-item-category" />
      <input type="hidden" name="itemId" value={item.id} />
      <select
        name="categoryId"
        defaultValue={item.categoryId ?? ""}
        onChange={(e) => fetcher.submit(e.currentTarget.form)}
        className="max-w-36 rounded-md border border-primary-200 bg-white px-1.5 py-1 text-xs"
      >
        <option value="">— inherit —</option>
        <CategoryOptions categories={categories} />
      </select>
    </fetcher.Form>
  );
}

export default function TransactionDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { transaction: txn, transferCandidates } = loaderData;
  const shell = useRouteLoaderData<typeof shellLoader>("routes/shell");
  const categories = shell?.categories ?? [];
  const [splitting, setSplitting] = useState(txn.splits.length > 0);
  const [splitLines, setSplitLines] = useState(
    Math.max(txn.splits.length, 2),
  );
  const confirmedMatches = txn.amazonMatches.filter(
    (m) => m.status === "confirmed",
  );

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/transactions" className="text-xs font-medium text-primary-600 hover:underline">
            ← Transactions
          </Link>
          <h1 className="mt-1 text-[16px] font-bold text-primary-950">{txn.merchant}</h1>
          <p className="text-sm text-gray-500">
            {txn.description} · {txn.account.name} · {formatDate(txn.date)}
          </p>
        </div>
        <div className="text-right">
          <Amount cents={txn.amountCents} bold />
          {txn.category && (
            <div className="mt-1">
              <ClassBadge spendingClass={txn.category.spendingClass} />
            </div>
          )}
        </div>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}

      <Card>
        <CardHeader title="Details" />
        <Form method="post" className="grid grid-cols-2 gap-3 p-4">
          <input type="hidden" name="intent" value="update" />
          <Field label="Date">
            <input type="date" name="date" defaultValue={txn.date} className={inputClass} />
          </Field>
          <Field label="Amount (negative = spend)">
            <input
              name="amount"
              defaultValue={centsToInput(txn.amountCents)}
              className={inputClass}
            />
          </Field>
          <Field label="Category">
            <select
              name="categoryId"
              defaultValue={txn.categoryId ?? ""}
              className={`${selectClass} w-full`}
            >
              <option value="">Uncategorized</option>
              <CategoryOptions categories={categories} />
            </select>
          </Field>
          <div className="col-span-2">
            <Field label="Notes">
              <input name="notes" defaultValue={txn.notes ?? ""} className={inputClass} />
            </Field>
          </div>
          <div className="col-span-2 flex justify-end">
            <Button type="submit">Save</Button>
          </div>
        </Form>
      </Card>

      {(txn.transferPeer || transferCandidates.length > 0) && (
        <Card>
          <CardHeader title="⇄ Transfer link" />
          <div className="p-4">
            {txn.transferPeer ? (
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-sm text-gray-700">
                  Opposite leg:{" "}
                  <Link
                    to={`/transactions/${txn.transferPeer.id}`}
                    className="font-bold text-primary-700 hover:underline"
                  >
                    {txn.transferPeer.account.name}
                  </Link>{" "}
                  · {formatDate(txn.transferPeer.date)} ·{" "}
                  <Amount cents={txn.transferPeer.amountCents} />
                  <span className="mt-1 block text-xs text-gray-500">
                    Linked transfers count as neither income nor spending.
                  </span>
                </p>
                <Form method="post">
                  <input type="hidden" name="intent" value="unlink-transfer" />
                  <Button variant="ghost" size="sm" type="submit">
                    Unlink
                  </Button>
                </Form>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">
                  This looks like it could be one leg of a transfer between your own
                  accounts. Linking it pairs the two legs and keeps both out of
                  income and spending.
                </p>
                {transferCandidates.map((c) => {
                  const other = c.out.id === txn.id ? c.in : c.out;
                  return (
                    <div key={other.id} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-700" title={other.description}>
                        <span className="font-bold">{other.accountName}</span> ·{" "}
                        {formatDate(other.date)} · {other.description}
                      </span>
                      <Amount cents={other.amountCents} />
                      <Form method="post">
                        <input type="hidden" name="intent" value="link-transfer" />
                        <input type="hidden" name="peerId" value={other.id} />
                        <Button size="sm" variant="secondary" type="submit">
                          ⇄ Link
                        </Button>
                      </Form>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Splits">
          {txn.splits.length > 0 && (
            <Form method="post">
              <input type="hidden" name="intent" value="clear-splits" />
              <Button variant="ghost" size="sm" type="submit">
                Clear splits
              </Button>
            </Form>
          )}
        </CardHeader>
        <div className="p-4">
          {!splitting ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Split this transaction across multiple categories — the lines replace
                the whole transaction in reports.
              </p>
              <Button variant="secondary" size="sm" onClick={() => setSplitting(true)}>
                Split…
              </Button>
            </div>
          ) : (
            <Form method="post" className="space-y-2">
              <input type="hidden" name="intent" value="save-splits" />
              {Array.from({ length: splitLines }).map((_, i) => {
                const existing = txn.splits[i];
                return (
                  <div key={i} className="flex gap-2">
                    <select
                      name="splitCategoryId"
                      defaultValue={existing?.categoryId ?? ""}
                      className={`${selectClass} flex-1`}
                    >
                      <option value="">— category —</option>
                      <CategoryOptions categories={categories} />
                    </select>
                    <input
                      name="splitAmount"
                      defaultValue={existing ? centsToInput(existing.amountCents) : ""}
                      placeholder="-12.34"
                      className={`${inputClass} w-28`}
                    />
                    <input
                      name="splitMemo"
                      defaultValue={existing?.memo ?? ""}
                      placeholder="memo"
                      className={`${inputClass} w-40`}
                    />
                  </div>
                );
              })}
              <div className="flex items-center justify-between pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSplitLines((n) => n + 1)}
                >
                  + Add line
                </Button>
                <p className="text-xs text-gray-500">
                  Lines must total <Amount cents={txn.amountCents} />
                </p>
                <Button type="submit" variant="secondary" size="sm">
                  Save splits
                </Button>
              </div>
            </Form>
          )}
        </div>
      </Card>

      {confirmedMatches.length > 0 && (
        <Card>
          <CardHeader title="Matched Amazon orders">
            <ItemSplitButton />
          </CardHeader>
          <div className="divide-y divide-primary-50">
            {confirmedMatches.map((m) => (
              <div key={m.id} className="p-4">
                <p className="text-xs font-medium text-gray-500">
                  Order {m.order.orderId} · {formatDate(m.order.orderDate)} ·{" "}
                  {formatCents(m.order.totalCents)}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {m.order.items.map((item) => (
                    <li key={item.id} className="flex items-center gap-3 text-sm">
                      <span className="flex-1 truncate text-gray-700" title={item.description}>
                        {item.description}
                      </span>
                      <ItemCategoryPicker item={item} categories={categories} />
                      <span className="w-20 shrink-0 text-right tabular-nums text-gray-500">
                        {formatCents(item.totalCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="border-t border-primary-100 px-4 py-2.5 text-xs text-gray-500">
            "Apply items as splits" categorizes this charge item-by-item — tax and
            shipping are spread proportionally so the split totals match exactly.
          </p>
        </Card>
      )}

      <Form
        method="post"
        onSubmit={(e) => {
          if (!confirm("Delete this transaction?")) e.preventDefault();
        }}
      >
        <input type="hidden" name="intent" value="delete" />
        <Button variant="danger" size="sm" type="submit">
          Delete transaction
        </Button>
      </Form>
    </div>
  );
}
