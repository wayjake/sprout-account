import { useCallback, useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  Outlet,
  useLocation,
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
import { BulkCategorizeWindow } from "~/components/bulk-categorize";
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
  MessageBar,
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

  // Set only by the redirect out of a commit or a close, and never persisted —
  // a bookmark or a revisit of this URL simply shows no banner.
  const added = url.searchParams.get("added");
  const commitStats = added
    ? {
        added: Number(added),
        balances: Number(url.searchParams.get("balances") ?? 0),
        skipped: Number(url.searchParams.get("skipped") ?? 0),
        transfers: Number(url.searchParams.get("transfers") ?? 0),
      }
    : null;

  // Cheap indexed count for the "showing X of Y" line
  const t = schema.transactions;
  const conds = [];
  if (filters.accountId) conds.push(eq(t.accountId, filters.accountId));
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(t)
    .where(conds.length ? and(...conds) : undefined);

  return { rows, nextCursor, totalCount: count, filters, commitStats };
}

// No action: the register itself writes nothing. A single row is edited in the
// `/transactions/:id` window nested below; a ticked selection is filed through
// `api/transactions/bulk`, which the bulk window posts to with a fetcher.

export default function Transactions({ loaderData }: Route.ComponentProps) {
  const { rows, nextCursor, totalCount, commitStats } = loaderData;
  const shell = useRouteLoaderData<typeof shellLoader>("routes/shell");
  const [searchParams] = useSearchParams();
  // The detail modal is a child route, so its URL has to carry the register's
  // filters — the register re-renders underneath it from the same search string
  // and closing the modal has to come back to the same page of the same list.
  const { search } = useLocation();
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
    "ids",
  ].some((k) => searchParams.get(k));
  // `?ids=` has no control in the filter bar — it arrives from a reconcile
  // diagnosis — so it needs saying out loud, or the register looks like it has
  // lost most of the ledger for no reason.
  const pinnedIds = loaderData.filters.ids?.length ?? 0;

  const categorizeRun = useCategorizeRun();
  const uncategorizedCount = shell?.uncategorizedCount ?? 0;

  // The commit redirect narrows to uncategorized; dropping that one filter
  // leaves the account and dates in place, so the link widens to the whole
  // import rather than to the whole ledger.
  const showingUncategorized = searchParams.get("category") === "none";
  const allImportedSearch = (() => {
    const next = new URLSearchParams(searchParams);
    next.delete("category");
    return next.toString();
  })();

  // ── Bulk selection ────────────────────────────────────────────────────────
  // A run of identical charges — daily cash adjustments, points redemptions —
  // is the same filing decision made once, and the transaction window is one
  // row at a time. Ticked rows go to the bulk window, which posts them to
  // `api/transactions/bulk` in one write.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const lastTickedRef = useRef<number | null>(null);

  // Always derived from the rows on screen, never read straight out of the Set:
  // a revalidation can drop rows out from under a selection (filing rows while
  // filtered to Uncategorized does exactly that), and a count taken from the
  // Set would go on claiming rows that are no longer here.
  const selectedRows = rows.filter((r) => selectedIds.has(r.id));
  const allTicked = rows.length > 0 && selectedRows.length === rows.length;

  // The selection belongs to the page it was made on. A new filter or a new
  // page is a different set of rows, so it starts over.
  useEffect(() => {
    setSelectedIds(new Set());
    setBulkOpen(false);
    setBulkMessage(null);
    lastTickedRef.current = null;
  }, [search]);

  const toggleRow = (index: number, shiftKey: boolean) => {
    const row = rows[index];
    if (!row) return;
    const turningOn = !selectedIds.has(row.id);
    // Shift-click fills the range from the last box touched — ticking eight
    // consecutive rows one at a time is most of the tedium this replaces.
    const anchor =
      shiftKey && lastTickedRef.current != null ? lastTickedRef.current : index;
    const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) {
        const id = rows[i]?.id;
        if (id == null) continue;
        if (turningOn) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    lastTickedRef.current = index;
  };

  const toggleAll = () => {
    setSelectedIds(allTicked ? new Set() : new Set(rows.map((r) => r.id)));
    lastTickedRef.current = null;
  };

  const deselect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleApplied = useCallback((message: string) => {
    // Closing and clearing together: the rows have been filed, and leaving them
    // ticked invites a second apply over a selection that is already done.
    setBulkMessage(message);
    setSelectedIds(new Set());
    setBulkOpen(false);
    lastTickedRef.current = null;
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-[16px] font-bold text-primary-950">
          📒 Transactions
        </h1>
        <CategorizeControl run={categorizeRun} uncategorizedCount={uncategorizedCount} />
      </div>

      <CategorizeStatus run={categorizeRun} />

      {bulkMessage && <MessageBar kind="success">{bulkMessage}</MessageBar>}

      {/* Landed here from a commit or a close. The filters above are already
          set to that import; this says what it did and offers the way out of
          the "uncategorized only" narrowing. */}
      {commitStats && (
        <MessageBar kind="success">
          {commitStats.added} transaction{commitStats.added === 1 ? "" : "s"} added
          {commitStats.balances > 0 &&
            `, ${commitStats.balances} balance${
              commitStats.balances === 1 ? "" : "s"
            } recorded`}
          {commitStats.skipped > 0 && `, ${commitStats.skipped} skipped as duplicates`}
          {commitStats.transfers > 0 &&
            `, ${commitStats.transfers} transfer pair${
              commitStats.transfers === 1 ? "" : "s"
            } linked between accounts`}
          .{" "}
          {showingUncategorized && (
            <Link to={{ search: `?${allImportedSearch}` }} className="font-bold underline">
              Show every row it added →
            </Link>
          )}
        </MessageBar>
      )}

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
        {/* `type="button"`: it opens the bulk window rather than submitting the
            filters it happens to sit inside. */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={selectedRows.length === 0}
          onClick={() => setBulkOpen(true)}
          title={
            selectedRows.length === 0
              ? "Tick the boxes beside the rows you want to change"
              : `Categorize the ${selectedRows.length} selected rows together`
          }
        >
          🗂 Bulk edit
          {selectedRows.length > 0 ? ` (${selectedRows.length})` : ""}
        </Button>
        {pinnedIds > 0 && (
          <span className="text-[11px] font-bold text-class-living">
            Showing {pinnedIds} specific row{pinnedIds === 1 ? "" : "s"}
          </span>
        )}
        {hasFilters && (
          <Link to="/transactions" className="text-[11px] font-bold text-primary-700 underline">
            Clear
          </Link>
        )}
      </Form>

      {rows.length === 0 ? (
        <EmptyState
          title={
            commitStats && showingUncategorized
              ? "Nothing left to file"
              : hasFilters
                ? "No transactions match these filters"
                : "No transactions yet"
          }
          detail={
            commitStats && showingUncategorized
              ? "Every row this import added already has a category."
              : hasFilters
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
                <th className="w-8 px-2 py-2.5 text-center">
                  <input
                    type="checkbox"
                    checked={allTicked}
                    // Partly-ticked has to be set on the node; there is no
                    // attribute for it.
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          selectedRows.length > 0 && !allTicked;
                    }}
                    onChange={toggleAll}
                    aria-label="Select every row on this page"
                    title="Select every row on this page"
                    className="h-4 w-4 accent-primary-600"
                  />
                </th>
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
              {rows.map((r, index) => (
                <tr
                  key={r.id}
                  className={
                    selectedIds.has(r.id)
                      ? "bg-primary-100"
                      : "hover:bg-primary-100"
                  }
                >
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(r.id)}
                      // Shift-click comes off the native event; a keyboard
                      // toggle simply reports no modifier and acts on one row.
                      onChange={(e) =>
                        toggleRow(
                          index,
                          (e.nativeEvent as MouseEvent).shiftKey === true,
                        )
                      }
                      aria-label={`Select ${r.merchant} on ${formatDate(r.date)}`}
                      className="h-4 w-4 accent-primary-600"
                    />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <ClearedMark state={r.cleared} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1 font-mono text-[11px] text-gray-600">
                    {formatDate(r.date)}
                  </td>
                  <td className="max-w-72 px-3 py-1">
                    <Link
                      to={`/transactions/${r.id}${search}`}
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
                      {/* Filing happens in the transaction window, where the
                          amount, the account, the notes and the transfer link
                          are all in view — a dropdown in a row of a list asks
                          you to categorize on the description alone. */}
                      <Link
                        to={`/transactions/${r.id}${search}`}
                        // Same destination as the merchant link one cell over,
                        // so it stays clickable without doubling the tab order.
                        tabIndex={-1}
                        className={`max-w-40 truncate text-[11px] hover:underline ${
                          r.categoryId == null
                            ? "bg-[#fff7dd] px-1 font-bold text-class-living"
                            : "text-gray-800"
                        }`}
                        title={
                          r.categoryId == null
                            ? "Uncategorized — open the transaction to file it"
                            : `Filed as ${r.categoryName} — open the transaction to change it`
                        }
                      >
                        {r.categoryName ?? "Uncategorized"}
                      </Link>
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

      {/* Kept mounted rather than mounted on demand, so `dialog.close()` runs
          and the platform hands focus back to the Bulk edit button. */}
      <BulkCategorizeWindow
        open={bulkOpen}
        rows={selectedRows}
        categories={categories}
        onClose={() => setBulkOpen(false)}
        onDeselect={deselect}
        onApplied={handleApplied}
      />

      {/* `/transactions/:id` — the detail window, drawn over this screen. */}
      <Outlet />
    </div>
  );
}
