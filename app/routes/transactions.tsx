import {
  Form,
  Link,
  data,
  useRouteLoaderData,
  useSearchParams,
} from "react-router";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import {
  listTransactions,
  parseCursor,
  parseTransactionFilters,
} from "~/.server/queries";
import { recordUserChoice } from "~/.server/categorize";
import { CategoryPicker } from "~/components/category-picker";
import {
  CategorizeControl,
  CategorizeStatus,
  useCategorizeRun,
} from "~/components/categorize-run";
import { Pagination } from "~/components/pagination";
import {
  Amount,
  Button,
  ClassBadge,
  ClearedMark,
  EmptyState,
  inputClass,
  selectClass,
} from "~/components/ui";
import { formatDate } from "~/lib/dates";
import { SPENDING_CLASSES } from "~/db/schema";
import { CLASS_LABELS } from "~/components/ui";
import type { loader as shellLoader } from "./shell";
import type { Route } from "./+types/transactions";

export function meta() {
  return [{ title: "Transactions · Sprout Account — Household Ledger" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const filters = parseTransactionFilters(url);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const { rows, nextCursor } = await listTransactions(filters, cursor);

  // Cheap indexed count for the "showing X of Y" line
  const t = schema.transactions;
  const conds = [];
  if (filters.accountId) conds.push(eq(t.accountId, filters.accountId));
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(t)
    .where(conds.length ? and(...conds) : undefined);

  return { rows, nextCursor, totalCount: count, filters };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "set-category") {
    const id = Number(form.get("id"));
    const categoryId = form.get("categoryId")
      ? Number(form.get("categoryId"))
      : null;
    const [txn] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, id))
      .limit(1);
    if (!txn) return data({ error: "Not found" }, { status: 404 });

    await db
      .update(schema.transactions)
      .set({ categoryId, categorySource: categoryId ? "user" : null })
      .where(eq(schema.transactions.id, id));
    if (categoryId) await recordUserChoice(txn.merchant, categoryId);
    return { ok: true };
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

export default function Transactions({ loaderData }: Route.ComponentProps) {
  const { rows, nextCursor, totalCount } = loaderData;
  const shell = useRouteLoaderData<typeof shellLoader>("routes/shell");
  const [searchParams] = useSearchParams();
  const categories = shell?.categories ?? [];
  const accounts = shell?.accounts ?? [];

  const hasFilters = [
    "account",
    "category",
    "class",
    "from",
    "to",
    "q",
    "reconciled",
  ].some((k) => searchParams.get(k));

  const categorizeRun = useCategorizeRun();
  const uncategorizedCount = shell?.uncategorizedCount ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-[16px] font-bold text-primary-950">
          📒 Transactions
        </h1>
        <CategorizeControl run={categorizeRun} uncategorizedCount={uncategorizedCount} />
      </div>

      <CategorizeStatus run={categorizeRun} />

      <Form method="get" className="bevel-out flex flex-wrap items-center gap-2 p-2">
        <input
          type="search"
          name="q"
          placeholder="Search description…"
          defaultValue={searchParams.get("q") ?? ""}
          className={`${inputClass} w-52`}
        />
        <select name="account" defaultValue={searchParams.get("account") ?? ""} className={selectClass}>
          <option value="">All accounts</option>
          {accounts
            .filter((a) => a.kind === "transaction")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <select name="category" defaultValue={searchParams.get("category") ?? ""} className={selectClass}>
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="class" defaultValue={searchParams.get("class") ?? ""} className={selectClass}>
          <option value="">All classes</option>
          {SPENDING_CLASSES.map((s) => (
            <option key={s} value={s}>
              {CLASS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          name="reconciled"
          defaultValue={searchParams.get("reconciled") ?? ""}
          className={selectClass}
        >
          <option value="">Reconciled or not</option>
          <option value="yes">Reconciled</option>
          <option value="no">Not reconciled</option>
        </select>
        <input type="date" name="from" defaultValue={searchParams.get("from") ?? ""} className={selectClass} />
        <input type="date" name="to" defaultValue={searchParams.get("to") ?? ""} className={selectClass} />
        <Button type="submit" variant="secondary" size="sm">
          🔍 Filter
        </Button>
        {hasFilters && (
          <Link to="/transactions" className="text-[11px] font-bold text-primary-700 underline">
            Clear
          </Link>
        )}
      </Form>

      {rows.length === 0 ? (
        <EmptyState
          title={hasFilters ? "No transactions match these filters" : "No transactions yet"}
          detail={
            hasFilters
              ? "Loosen the filters and search again."
              : "Import a transaction export to get started."
          }
        >
          {!hasFilters && (
            <Link to="/import" className="bevel-btn px-3 py-1 text-[11px] font-bold">
              📥 Import statements
            </Link>
          )}
        </EmptyState>
      ) : (
        <div className="bevel-in overflow-x-auto bg-white p-[2px]">
          <table className="ledger-stripes w-full text-[12px]">
            <thead>
              <tr className="bevel-out text-left text-[11px] font-bold text-gray-800">
                <th
                  className="w-6 px-2 py-2.5 text-center"
                  title="Reconciled — ✓ ties out, ! in a period that is off, · not yet checked"
                >
                  R
                </th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5">Account</th>
                <th className="px-4 py-2.5">Category</th>
                <th className="px-4 py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-primary-100">
                  <td className="px-2 py-1 text-center">
                    <ClearedMark state={r.cleared} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1 font-mono text-[11px] text-gray-600">
                    {formatDate(r.date)}
                  </td>
                  <td className="max-w-72 px-3 py-1">
                    <Link
                      to={`/transactions/${r.id}`}
                      className="block truncate font-bold text-gray-900 hover:text-primary-700 hover:underline"
                      title={r.description}
                    >
                      {r.merchant}
                    </Link>
                    <span className="block truncate text-[10px] text-gray-500">
                      {r.description}
                      {r.splitCount > 0 && (
                        <span className="ml-1 bg-primary-700 px-1 text-[9px] font-bold text-white">
                          ✂ {r.splitCount} splits
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1 text-[11px] text-gray-600">
                    {r.accountName}
                  </td>
                  <td className="px-3 py-1">
                    <div className="flex items-center gap-1.5">
                      <CategoryPicker
                        transactionId={r.id}
                        categoryId={r.categoryId}
                        categories={categories}
                        action="/transactions"
                      />
                      {r.spendingClass && <ClassBadge spendingClass={r.spendingClass} />}
                      {r.transferPeerId != null && (
                        <span
                          className="whitespace-nowrap text-[10px] font-bold text-primary-700"
                          title={`Linked transfer — opposite leg in ${r.transferPeerAccount ?? "another account"}`}
                        >
                          ⇄ {r.transferPeerAccount}
                        </span>
                      )}
                      {r.categorySource === "ai" && (
                        <span title="Categorized by AI" className="text-[10px]">
                          🔮
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1 text-right">
                    <Amount cents={r.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        nextCursor={nextCursor}
        shownCount={rows.length}
        totalCount={totalCount}
      />
    </div>
  );
}
