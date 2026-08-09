import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { TransactionListRow } from "~/.server/queries";
import type { Category } from "~/db/schema";
import { CategoryCombobox } from "~/components/category-picker";
import { PaneWindow } from "~/components/pane-window";
import { Amount, Button, ClassBadge, MessageBar } from "~/components/ui";
import { formatDate } from "~/lib/dates";

/**
 * File a whole selection of register rows under one category.
 *
 * The rows come from the register's own page data — the selection is client
 * state and every selected row is on screen — so this window has no loader of
 * its own; it posts to `api/transactions/bulk` with a fetcher, whose submission
 * revalidates the register underneath.
 *
 * Kept mounted by the register and opened through `open`, so the native
 * `<dialog>` handles closing and hands focus back to the button that opened it.
 */
export function BulkCategorizeWindow({
  open,
  rows,
  categories,
  onClose,
  onDeselect,
  onApplied,
}: {
  open: boolean;
  /** The selected rows, already narrowed to what is on the page. */
  rows: TransactionListRow[];
  categories: Category[];
  onClose: () => void;
  /** Untick one row from inside the window. */
  onDeselect: (id: number) => void;
  onApplied: (message: string) => void;
}) {
  const fetcher = useFetcher<{
    ok?: true;
    updated?: number;
    remembered?: number;
    categoryName?: string;
    error?: string;
  }>();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [remember, setRemember] = useState(true);
  // A fetcher keeps its last response for as long as it lives, so an error from
  // one selection would greet the next one. Only a submission from this opening
  // of the window gets to show its result.
  const [attempted, setAttempted] = useState(false);
  const busy = fetcher.state !== "idle";

  // Distinct merchants are what memory is keyed on, and what makes this worth
  // doing at all for a repeated charge — so it is said out loud.
  const merchants = [...new Set(rows.map((r) => r.merchant).filter(Boolean))];
  const splitRows = rows.filter((r) => r.splitCount > 0);
  // Two different things, and only the first one has another leg to talk about.
  // A row filed as a transfer without a peer is common — `autoLinkTransfers`
  // only pairs what it is sure about. (Legs pointing at a balance-only account
  // can't be spotted here at all: the register doesn't select
  // `transferAccountId`, so this warning is narrow on purpose.)
  const peerLinkedRows = rows.filter((r) => r.transferPeerId != null);
  const transferFiledRows = rows.filter(
    (r) => r.transferPeerId == null && r.spendingClass === "transfer",
  );

  // The window closes on the way out, so the next selection starts clean.
  useEffect(() => {
    if (open) return;
    setCategoryId(null);
    setRemember(true);
    setAttempted(false);
  }, [open]);

  const appliedRef = useRef(false);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) {
      appliedRef.current = false;
      return;
    }
    if (appliedRef.current) return;
    appliedRef.current = true;
    const { updated = 0, remembered = 0, categoryName } = fetcher.data;
    onApplied(
      `${updated} transaction${updated === 1 ? "" : "s"} filed as ${categoryName}` +
        (remembered > 0
          ? `, and remembered for ${remembered} merchant${remembered === 1 ? "" : "s"}.`
          : "."),
    );
  }, [fetcher.state, fetcher.data, onApplied]);

  const apply = () => {
    if (categoryId == null || rows.length === 0) return;
    setAttempted(true);
    fetcher.submit(
      {
        intent: "categorize",
        ids: rows.map((r) => r.id).join(","),
        categoryId: String(categoryId),
        ...(remember ? { remember: "on" } : {}),
      },
      { method: "post", action: "/api/transactions/bulk" },
    );
  };

  return (
    <PaneWindow
      open={open}
      title={`🗂 Categorize ${rows.length} transaction${rows.length === 1 ? "" : "s"}`}
      width="42rem"
      onClose={onClose}
    >
      <div className="space-y-3 p-3">
        {attempted && fetcher.data?.error && (
          <MessageBar kind="error">{fetcher.data.error}</MessageBar>
        )}

        {rows.length === 0 ? (
          // Reachable by unticking the last row from in here. The Bulk edit
          // button behind is disabled again, so this branch has to offer its own
          // way out rather than leaving only the titlebar ✕.
          <>
            <MessageBar kind="info">
              Nothing is selected any more. Tick the rows you want to file and
              open this again.
            </MessageBar>
            <div className="flex justify-end pt-1">
              <Button type="button" variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[12px] text-gray-800">
              Every row below gets the same category.{" "}
              {merchants.length === 1
                ? "They are all the same merchant."
                : `${merchants.length} different merchants.`}
            </p>

            {(splitRows.length > 0 ||
              peerLinkedRows.length > 0 ||
              transferFiledRows.length > 0) && (
              <MessageBar kind="info">
                {splitRows.length > 0 && (
                  <>
                    {splitRows.length} of these {splitRows.length === 1 ? "is" : "are"}{" "}
                    already split across categories — a category here sits over the
                    split, it doesn&apos;t replace it.{" "}
                  </>
                )}
                {peerLinkedRows.length > 0 && (
                  <>
                    {peerLinkedRows.length}{" "}
                    {peerLinkedRows.length === 1
                      ? "is a linked transfer leg"
                      : "are linked transfer legs"}
                    : filing {peerLinkedRows.length === 1 ? "it" : "them"} as
                    spending or income puts{" "}
                    {peerLinkedRows.length === 1 ? "it" : "them"} back into
                    reporting while the opposite leg stays out of it.{" "}
                  </>
                )}
                {transferFiledRows.length > 0 && (
                  <>
                    {transferFiledRows.length}{" "}
                    {transferFiledRows.length === 1 ? "is" : "are"} currently filed
                    as a transfer, so a spending or income category here brings{" "}
                    {transferFiledRows.length === 1 ? "it" : "them"} into
                    income/spend reporting.
                  </>
                )}
              </MessageBar>
            )}

            <div className="bevel-in max-h-64 overflow-y-auto bg-white p-[2px]">
              <table className="ledger-stripes w-full text-[12px]">
                <thead>
                  <tr className="bevel-out text-left text-[11px] font-bold text-gray-800">
                    <th className="px-3 py-1.5">Date</th>
                    <th className="px-3 py-1.5">Description</th>
                    <th className="px-3 py-1.5">Account</th>
                    <th className="px-3 py-1.5">Category now</th>
                    <th className="px-3 py-1.5 text-right">Amount</th>
                    <th className="w-8 px-2 py-1.5">
                      <span className="sr-only">Remove from selection</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-3 py-1 font-mono text-[11px] text-gray-600">
                        {formatDate(r.date)}
                      </td>
                      <td className="max-w-56 px-3 py-1">
                        <span className="block truncate font-bold text-gray-900">
                          {r.merchant}
                        </span>
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
                          <span
                            className={`max-w-32 truncate text-[11px] ${
                              r.categoryId == null
                                ? "bg-[#fff7dd] px-1 font-bold text-class-living"
                                : "text-gray-800"
                            }`}
                          >
                            {r.categoryName ?? "Uncategorized"}
                          </span>
                          {r.spendingClass && (
                            <ClassBadge spendingClass={r.spendingClass} />
                          )}
                          {r.transferPeerId != null && (
                            <span
                              className="whitespace-nowrap text-[10px] font-bold text-primary-700"
                              title={`Linked transfer — opposite leg in ${r.transferPeerAccount ?? "another account"}`}
                            >
                              ⇄ {r.transferPeerAccount}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1 text-right">
                        <Amount cents={r.amountCents} />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => onDeselect(r.id)}
                          className="px-1 text-[11px] font-bold text-gray-600 hover:text-negative"
                          aria-label={`Remove ${r.merchant} on ${formatDate(r.date)} from this selection`}
                        >
                          <span aria-hidden>✕</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="groove space-y-2 bg-ledger p-2">
              <CategoryCombobox
                name="bulkCategoryId"
                categories={categories}
                label="File all of them as"
                allowClear={false}
                placeholder="Type to search categories…"
                className="max-w-72"
                onSelect={setCategoryId}
              />
              <label className="flex items-start gap-2 text-[11px] text-gray-800">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.currentTarget.checked)}
                  className="mt-[2px] h-4 w-4 accent-primary-600"
                />
                <span>
                  Remember this for{" "}
                  {merchants.length === 1
                    ? "this merchant"
                    : `these ${merchants.length} merchants`}
                  , so future imports file{" "}
                  {merchants.length === 1 ? "it" : "them"} the same way. Overwrites
                  anything already remembered.
                </span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={apply}
                disabled={busy || categoryId == null}
                title={
                  categoryId == null ? "Pick a category first" : undefined
                }
              >
                {busy
                  ? "Filing…"
                  : `Apply to ${rows.length} transaction${rows.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </>
        )}
      </div>
    </PaneWindow>
  );
}
